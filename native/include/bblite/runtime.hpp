#pragma once

#include <array>
#include <cstdint>
#include <functional>
#include <limits>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace bbl {

namespace js {
template <typename T>
class Array;
template <typename T>
class Nullable;
class U8Array;
}

inline constexpr float pi = 3.14159265358979323846f;
// Camera angles are JavaScript numbers upstream, so `Math.PI / 2` reaches
// `Math.cos` as a double and not as its float32 neighbour. The two differ
// enough to matter: `cos` of the double is 6.1e-17 and of the float
// -4.4e-8, which is a whole ulp band in the composed view matrix.
inline constexpr double pi_double = 3.14159265358979323846;
inline constexpr std::uint32_t invalid_handle = std::numeric_limits<std::uint32_t>::max();
inline constexpr std::uint32_t material_family_pbr = 1u << 0;
inline constexpr std::uint32_t material_family_standard = 1u << 1;
inline constexpr std::uint32_t material_family_shader = 1u << 2;
inline constexpr std::uint32_t material_family_grid = 1u << 3;

struct Vec3 {
    float x = 0.0f;
    float y = 0.0f;
    float z = 0.0f;
};

// A position the pinned engine keeps as three JavaScript numbers -- the
// camera's, and a node's translation, which at large-world coordinates has
// to survive a float32 grid whose spacing is half a unit.
struct Vec3d {
    double x = 0.0;
    double y = 0.0;
    double z = 0.0;
};

struct Vec2 {
    float x = 0.0f;
    float y = 0.0f;
};

struct Vec4 {
    float x = 0.0f;
    float y = 0.0f;
    float z = 0.0f;
    float w = 0.0f;
};

struct Color3 {
    float r = 1.0f;
    float g = 1.0f;
    float b = 1.0f;
};

struct Color4 {
    float r = 0.05f;
    float g = 0.06f;
    float b = 0.09f;
    float a = 1.0f;
};

struct EngineOptions {
    std::string title = "Babylon Lite Native";
    int width = 1280;
    int height = 720;
};

/** Browser-neutral keyboard data delivered by the platform event loop. */
struct PlatformKeyboardEvent {
    std::string code{};
    std::string key{};
    bool repeat = false;
};

/** Browser-neutral mouse-button data delivered by the platform event loop. */
struct PlatformMouseEvent {
    double button = 0.0;
    double client_x = 0.0;
    double client_y = 0.0;
};

struct MeshHandle {
    std::uint32_t value = invalid_handle;

    // A handle is an id, so comparing ids is exactly the object
    // identity JavaScript compares meshes by.
    [[nodiscard]] bool operator==(
        const MeshHandle&) const = default;
};

struct MaterialHandle {
    std::uint32_t value = invalid_handle;
};

struct LightHandle {
    std::uint32_t value = invalid_handle;
};

struct CameraHandle {
    std::uint32_t value = invalid_handle;
};

struct TransformNodeHandle {
    std::uint32_t value = invalid_handle;
};

struct AssetHandle {
    std::uint32_t value = invalid_handle;
};

struct AnimationGroupHandle {
    std::uint32_t value = invalid_handle;
};

struct RenderTargetHandle {
    std::uint32_t value = invalid_handle;
};

struct TaskHandle {
    std::uint32_t value = invalid_handle;
};

struct SpriteAtlasHandle {
    std::uint32_t value = invalid_handle;
};

struct Sprite2DLayerHandle {
    std::uint32_t value = invalid_handle;
};

struct SpriteRendererHandle {
    std::uint32_t value = invalid_handle;
};

struct SpriteRenderTextureHandle {
    std::uint32_t value = invalid_handle;
};

struct BillboardSystemHandle {
    std::uint32_t value = invalid_handle;
};

/**
 * One skeleton the opt-in bone-control chunk built, one per glTF skin
 * instance (`AssetContainer.skeletons`).
 */
struct SkeletonHandle {
    std::uint32_t value = invalid_handle;
};

/** One joint of a skeleton, addressed by name through `getBoneByName`. */
struct BoneHandle {
    std::uint32_t value = invalid_handle;
};

struct EffectWrapperHandle {
    std::uint32_t value = invalid_handle;
};

struct EffectRendererHandle {
    std::uint32_t value = invalid_handle;
};

struct SplatMeshHandle {
    std::uint32_t value = invalid_handle;
};

struct ShadowGeneratorHandle {
    std::uint32_t value = invalid_handle;
};

struct GpuPickerHandle {
    std::uint32_t value = invalid_handle;
};

/**
 * Which collection a pick resolved into.
 *
 * Upstream `PickingInfo.pickedMesh` is one object reference whatever was
 * hit, because a mesh and a Gaussian cloud are both SceneNodes there. This
 * port keeps them in separate collections, so the identity is the pair --
 * and the name, which is all the reached slice reads, is resolved once at
 * pick time rather than re-derived at every read.
 */
enum class PickedNodeKind : std::uint8_t {
    none,
    mesh,
    splat_mesh,
};

/**
 * The pin's `PickingInfo`, at the slice this port resolves.
 *
 * WHAT WAS HIT plus the basic pipeline's reconstructed world point. `ray`,
 * `bu`, `bv` and `thinInstanceIndex` belong to the detailed and advanced
 * pipelines and remain outside this record.
 */
struct PickingInfo {
    bool hit = false;
    /**
     * WHICH node was hit. Upstream `pickedMesh` is a live reference and
     * `.name` reads it at the moment the scene asks, so the identity is
     * what the pick resolves and the name is read through it -- a scene
     * that picks, renames the node and then reads would otherwise get the
     * name the node had at pick time.
     */
    PickedNodeKind picked_kind = PickedNodeKind::none;
    std::uint32_t picked_index = invalid_handle;
    std::optional<std::array<double, 3>> picked_point{};
};


/**
 * The picker's own state. The GPU resources it owns live with the renderer
 * -- only the renderer knows how to make them -- so this record carries the
 * scene it picks in and the slot the backend keeps its resources under.
 */
struct GpuPickerRecord {
    bool disposed = false;
};

enum class PrimitiveKind {
    babylon,
    box,
    gltf,
    ground,
    sphere,
    torus,
};

enum class CameraKind {
    arc_rotate,
    free,
};

enum class LightKind {
    directional,
    hemispheric,
    point,
    spot,
};

enum class MaterialAlphaMode {
    opaque,
    mask,
    blend,
};

/**
 * The record lane a property clip animates.
 *
 * Upstream a path is any dotted string, resolved by
 * `resolvePropertyBinding` against the object the group was bound to: the
 * walk ends on an owner and a final property name, and the writer stores
 * either the whole value or the one component the path named. So a lane is
 * what the port enumerates and a component is carried beside it — the same
 * split the pin makes, rather than one enumerator per spelled path.
 */
enum class PropertyAnimationPath {
    position,
    scaling,
    rotation_quaternion,
    camera_alpha,
};

/**
 * Which part of its lane a track writes. `whole_lane` is the path that
 * names the lane itself, which `createPropertyWriter` stores through the
 * value's own `set`; the rest name one component, in the pin's own
 * `"xyzw"` order.
 */
enum class PropertyAnimationComponent {
    whole_lane,
    x,
    y,
    z,
    w,
};

/**
 * What a property clip is bound to. Upstream resolves a dotted path
 * against whatever object the caller passed, so the target and the path
 * travel together; here the reached objects are a mesh and a camera, and
 * each path belongs to one of them.
 */
enum class PropertyAnimationTargetKind {
    mesh,
    camera,
};

struct PropertyAnimationTarget {
    PropertyAnimationTargetKind kind =
        PropertyAnimationTargetKind::mesh;
    std::uint32_t index = 0;
};

enum class PropertyAnimationInterpolation {
    linear,
    step,
};

enum class GeometryTextureType {
    irradiance,
    world_position,
    local_position,
    reflectivity,
    view_depth,
    normalized_view_depth,
    screenspace_depth,
    view_normal,
    world_normal,
    albedo,
    linear_velocity,
};

enum class GeometryTextureFormat {
    automatic,
    r16_float,
};

struct GeometryTextureDescription {
    GeometryTextureType type = GeometryTextureType::irradiance;
    GeometryTextureFormat format = GeometryTextureFormat::automatic;
};

struct NormalizedViewport {
    double x = 0.0;
    double y = 0.0;
    double width = 1.0;
    double height = 1.0;
};

/**
 * The pixels a normalized viewport covers on a given target.
 *
 * Which pixels is the pin's question and each frame-graph task answers it its
 * own way -- a copy task rounds its far edges down, a post-process pass rounds
 * them up -- so only the rectangle is shared, never the rounding.
 */
struct PixelViewport {
    std::int32_t x = 0;
    std::int32_t y = 0;
    std::int32_t width = 0;
    std::int32_t height = 0;
};

/**
 * A texture format, as the classes this port's two backends both express.
 *
 * Each backend only translates the class to its API's format constant, so a
 * record naming one says the same thing to both. The geometry attachments
 * choose theirs by lane (`pbr-geometry-output-shader.ts`): reflectivity and
 * albedo pack into rgba8, VIEW_DEPTH keeps full float precision, the
 * normalized and screenspace depths take r16 -- as does any attachment whose
 * description asks for it -- and every other lane is rgba16. A post-process
 * composite names its own instead: the circle-of-confusion map is r16.
 */
enum class TextureFormatClass {
    rgba8_unorm,
    r16_float,
    r32_float,
    rgba16_float,
};

struct RenderTargetOptions {
    std::uint32_t samples = 1;
    bool has_color = true;
    bool has_depth = false;
    bool sampled_depth = false;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    /**
     * A target sized as a fraction of another, rather than in pixels or by the
     * canvas. A post-process composite owns its intermediates and sizes each
     * from its source every time the graph is built, so a window resize moves
     * them with it. `scale_source` must already exist: the composite creates
     * its own intermediates after the source it scales from.
     */
    RenderTargetHandle scale_source{};
    double width_ratio = 1.0;
    double height_ratio = 1.0;
    /** The colour format, when the target does not take the surface's. */
    TextureFormatClass format = TextureFormatClass::rgba8_unorm;
    bool has_format = false;
    /** See `RenderTargetRecord::shadow_map`. */
    bool shadow_map = false;
};

enum class RenderTextureSource {
    render_target,
    geometry,
    geometry_output,
    /** A geometry task's own depth attachment, aliased by the pin's eager
     *  wrapper target: a later pass binds and loads it rather than owning it. */
    geometry_depth,
};

struct RenderTextureRef {
    RenderTextureSource source = RenderTextureSource::render_target;
    RenderTargetHandle target{};
    TaskHandle task{};
    GeometryTextureType geometry_type = GeometryTextureType::irradiance;
};

struct RenderTaskOptions {
    std::string name;
    RenderTargetHandle target{};
    Color4 clear_color{};
    bool clear = false;
    CameraHandle camera{};
    bool has_camera = false;
    bool canvas_size = false;
    bool auto_mirror = true;
    /**
     * A depth attachment owned by another task, bound instead of the target's
     * own — `geometry_depth` when the scene named one, and the default
     * `render_target` when it did not. The pin marks such a target eager, so
     * the pass loads the depth already in it and neither builds nor disposes
     * it.
     */
    RenderTextureRef depth{};
    /**
     * A single-sample target the colour attachment resolves into at
     * end-of-pass, so an MSAA render can feed a post-process that needs a
     * single-sample source without a separate resolve pass. Only read when
     * the task's own target is multisampled, which is the pin's rule.
     */
    RenderTargetHandle resolve_target{};
    /**
     * The generator this pass renders the shadow map for.
     *
     * The pin builds a `RenderTask` per PCF generator and installs the
     * light-space matrices on a camera facade whose caches it pins
     * (`updateShadowCameraBase`), so the pass reads them straight back
     * instead of composing a perspective from a camera record. There is no
     * such facade here: the task names its generator and the frame builds
     * the pass's scene block from that generator's own biased
     * view-projection.
     */
    ShadowGeneratorHandle shadow_generator{};
};

struct RenderTaskMesh {
    MeshHandle mesh{};
    MaterialHandle material{};
};

struct GeometryTaskOptions {
    std::string name;
    std::uint32_t shader_index = 0;
    std::uint32_t samples = 1;
    std::vector<GeometryTextureDescription> attachments;
    RenderTargetHandle target{};
    bool clear_target = false;
    Color4 target_clear_color{};
};

struct CopyTaskOptions {
    std::string name;
    RenderTextureRef source{};
    RenderTargetHandle target{};
    RenderTargetHandle resolve_target{};
    bool has_viewport = false;
    NormalizedViewport viewport{};
};

/**
 * A WebGPU blend factor, as this runtime's own enumerator, and the four a
 * blend state carries. The operation is always add — the pinned descriptors
 * this port reaches never write another one — so a state is its factors.
 * Generated code names these (the post-process alpha modes) and so does every
 * blending pipeline in both backends, which is why they sit with the records
 * rather than in a PAL header.
 */
enum class BlendFactor {
    one,
    src_alpha,
    one_minus_src_alpha,
};

struct BlendFactors {
    BlendFactor src_color = BlendFactor::one;
    BlendFactor dst_color = BlendFactor::one;
    BlendFactor src_alpha = BlendFactor::one;
    BlendFactor dst_alpha = BlendFactor::one;
};

enum class PostProcessSampling {
    nearest,
    linear,
};

/**
 * A fullscreen pass that samples one texture and writes another.
 *
 * Every post-process effect Babylon Lite ships is this pass with a different
 * composed stage, so the record carries the pass and the effect's parameter
 * vector rather than one struct per effect. `shader_index` selects both the
 * deployed stage pair and the generated uniform writer; passes are numbered in
 * the order generation reached them, a composite's own passes included.
 */
struct PostProcessPassOptions {
    std::string name;
    std::uint32_t shader_index = 0;
    RenderTextureRef source{};
    /** The target the caller named, or an invalid handle for none. */
    RenderTargetHandle target{};
    PostProcessSampling sampling = PostProcessSampling::linear;
    /** The pin's `PostProcessAlphaMode`: 0, 1, 2 or 7. */
    std::uint32_t alpha_mode = 0;
    bool has_viewport = false;
    NormalizedViewport viewport{};
    bool clear = true;
    /** The views the effect binds after the source, in its own order. */
    std::vector<RenderTextureRef> extra_textures;
    /** Read by the effects whose uniforms carry the camera planes. */
    CameraHandle camera{};
    /** The effect's own `params`, in the order its writer reads them. */
    std::vector<double> params;
    /** Resolved at creation: the caller's target, or the pass's own. */
    RenderTargetHandle output_target{};
    /** Set by `updateUniforms`, cleared when a backend rewrites the block. */
    bool uniforms_dirty = true;
};

/**
 * The task the scene added, and the passes it records.
 *
 * A plain effect records one. A composite -- depth of field -- records the
 * chain its own factory built, over intermediate targets it owns, and the
 * caller still sees one task: one `addTask`, one `updateUniforms`, one output.
 * So the task holds a list and the single-pass case is a list of one, rather
 * than the composites being a second kind of task beside this one.
 */
struct PostProcessTaskOptions {
    std::string name;
    std::vector<PostProcessPassOptions> passes;
};

/**
 * What a composite reads from the scene.
 *
 * Everything else about it -- how many passes, over which intermediates, at
 * which sizes -- was settled at generation by running the pin's own factory,
 * so the generated `create_composite_post_process_task_N` carries the chain
 * and takes only this.
 *
 * The source is a render target rather than any render texture because the
 * composite sizes its own intermediates from it; the pin refuses a source
 * without a format for the same reason.
 */
struct PostProcessCompositeInputs {
    std::string name;
    RenderTargetHandle source{};
    /** The composite's own config textures, in its descriptor's order. */
    std::vector<RenderTextureRef> extra_textures;
    /** The target the caller named, or an invalid handle for none. */
    RenderTargetHandle target{};
    CameraHandle camera{};
};

/**
 * An `EffectRenderTask`: the same draw, into a target the caller owns.
 *
 * The clear state carries no default here, and neither do its two siblings
 * below: the pin's `clear !== false` and `clearColor ?? opaque black` are
 * asserted at generation and emitted explicitly at every call site, so a
 * default in this file would be a fourth statement of a pinned value that
 * nothing exercises and nothing checks.
 */
struct EffectTaskOptions {
    std::string name;
    EffectWrapperHandle effect{};
    RenderTargetHandle target{};
    bool clear = false;
    Color4 clear_color{};
};

enum class FrameTaskKind {
    render,
    geometry,
    copy,
    post_process,
    effect,
};

struct RenderTargetRecord {
    std::uint32_t samples = 1;
    bool has_color = true;
    bool has_depth = false;
    bool sampled_depth = false;
    bool swapchain = false;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    /** See `RenderTargetOptions::scale_source`. */
    RenderTargetHandle scale_source{};
    double width_ratio = 1.0;
    double height_ratio = 1.0;
    TextureFormatClass format = TextureFormatClass::rgba8_unorm;
    bool has_format = false;
    /**
     * This target is a shadow generator's own map
     * (`createShadowRenderTarget`), which is the pin's ONE exception to
     * every convention the frame's attachments take: a `depth32float`
     * format sampled through a comparison sampler, standard-Z rather than
     * this port's reverse-Z, and a far clear of 1 rather than 0.
     *
     * The flag says which target it is; the four values it implies are the
     * `shadow_map_depth_*` constants generation emits from the pinned
     * descriptor, so no PAL types one out.
     */
    bool shadow_map = false;
};

struct FrameTaskRecord {
    FrameTaskKind kind = FrameTaskKind::render;
    RenderTaskOptions render;
    std::vector<RenderTaskMesh> render_meshes;
    GeometryTaskOptions geometry;
    CopyTaskOptions copy;
    PostProcessTaskOptions post_process;
    EffectTaskOptions effect;
};

struct RenderTargetTexture {
    RenderTargetHandle rt{};
    RenderTextureRef texture{};
};

/**
 * A 1x1 texture `createSolidTexture2D` built.
 *
 * The pin writes `Math.round(channel * 255)` into an `rgba8unorm` texel
 * (`solid-texture.ts`), so the byte IS the texture and the float is only how
 * the caller spelled it. `create_solid_texture` performs that rounding once,
 * under the contract `factory-lowerer.ts` asserts against the pinned call,
 * and everything downstream reads the result: no consumer re-derives the
 * formula, which is what kept three spellings of it in the tree.
 */
struct SolidTexture {
    Color4 color{};
    std::array<std::uint8_t, 4> texel{};
};

struct PbrMaterialOptions {
    SolidTexture base_color{};
    Color4 base_color_factor{1.0f, 1.0f, 1.0f, 1.0f};
    SolidTexture orm{};
    float metallic_factor = 1.0f;
    float roughness_factor = 1.0f;
    float direct_intensity = 1.0f;
    float environment_intensity = 1.0f;
    float alpha = 1.0f;
    bool alpha_blend = false;
    // Pinned default: the dielectric F0 the PBR material seeds (0.04).
    float reflectance = 0.04f;
    bool unlit = false;
    bool double_sided = false;
    bool specular_aa = false;
    bool skybox_mode = false;
    float transmission_factor = 0.0f;
    // Pinned default: gltf-ext-dielectric.ts treats ior 1.5 as neutral.
    float index_of_refraction = 1.5f;
    float thickness = 0.0f;
    bool use_thickness_as_depth = false;
    bool has_volume = false;
    Color3 attenuation_color{1.0f, 1.0f, 1.0f};
    float attenuation_distance = 1.0f;
    float occlusion_strength = 1.0f;
    float metallic_f0_factor = 1.0f;
    // The pin's `usePhysicalLightFalloff`, whose default is true: a point or
    // spot light attenuates by inverse square, and the spot cone by the
    // physical exponential. False takes the Standard-style linear range and
    // spot exponent instead. Both arms are composed into every punctual
    // fragment; this is the lane that selects one (`_writeMaterialData`).
    bool use_physical_light_falloff = true;
};

struct GridMaterialOptions {
    Color3 main_color{0.0f, 0.0f, 0.0f};
    Color3 line_color{0.0f, 0.5f, 0.5f};
    float grid_ratio = 1.0f;
    Vec3 grid_offset{};
    float major_unit_frequency = 10.0f;
    float minor_unit_visibility = 0.33f;
    float opacity = 1.0f;
    float visibility = 1.0f;
    bool antialias = true;
    bool pre_multiply_alpha = false;
    bool use_max_line = false;
    bool back_face_culling = true;
};

enum class TextureFilter {
    nearest,
    linear,
};

enum class TextureMipmapMode {
    nearest,
    linear,
};

enum class TextureAddressMode {
    repeat,
    clamp,
    mirror,
};

struct TextureSamplerState {
    TextureFilter min_filter = TextureFilter::linear;
    TextureFilter mag_filter = TextureFilter::linear;
    TextureMipmapMode mipmap_mode = TextureMipmapMode::linear;
    TextureAddressMode address_u = TextureAddressMode::repeat;
    TextureAddressMode address_v = TextureAddressMode::repeat;
    float max_anisotropy = 1.0f;
    float max_lod = 1000.0f;
};

/**
 * The pin's `Texture2D` transform properties (`texture-2d.ts`).
 *
 * Upstream these are plain fields on the one `Texture2D` every loader and
 * factory returns, read by `writeUvTransformData` when a material marked by
 * `enableMaterialUvTransform` builds its renderable. A texture nothing marks
 * never has them read, which is why the defaults are the identity rather than
 * a "has transform" flag: the pin has no such flag either.
 */
struct TextureUvTransform {
    // Plain JavaScript numbers upstream, which `writeUvTransformData` reads
    // into a rotation and a scale before its single float32 store -- so they
    // are doubles here for the same reason `CameraRecord`'s scalars are.
    // Rounding them on the record would round one step early.
    double u_scale = 1.0;
    double v_scale = 1.0;
    double u_offset = 0.0;
    double v_offset = 0.0;
    double u_ang = 0.0;
};

/** One mip level of a compressed texture, as its container stores it. */
struct CompressedMipLevel {
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    std::vector<std::uint8_t> bytes;
};

/**
 * A texture whose bytes are already GPU blocks.
 *
 * `ktx-loader.ts` and `basis-loader.ts` both end at
 * `device.queue.writeTexture` over a block-compressed format, with the mip
 * chain the container carries rather than one the engine blits — so nothing
 * here is decoded, and the chain is uploaded as it arrives.
 *
 * `format` is the pin's own WebGPU format name (`bc2-rgba-unorm`), which is
 * what each backend translates: the name is the pinned table's, so a format
 * the pin adds needs no enumerator here. It is a view into the generated
 * format table's static storage, which is the only thing that ever fills it.
 */
struct CompressedTexture {
    std::string_view format{};
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    std::uint32_t block_width = 0;
    std::uint32_t block_height = 0;
    std::uint32_t block_bytes = 0;
    std::vector<CompressedMipLevel> mips;
};

struct TextureData {
    std::vector<std::uint8_t> bytes;
    // When both are non-zero, `bytes` are RGBA texels at this size rather
    // than an encoded image. `createTexture2DFromPixels` hands over the
    // caller's own bytes where every loader hands over a file, and the pin
    // has one `Texture2D` for both — so one material slot has to hold
    // either, and the size is what says which.
    std::uint32_t rgba_width = 0;
    std::uint32_t rgba_height = 0;
    TextureUvTransform uv_transform{};
    TextureSamplerState sampler{};
    // The pin's *upload* flip: `loadTexture2D`'s `invertY` option, passed as
    // `flipY` to `copyExternalImageToTexture` (texture-2d.ts). The PALs'
    // shared `decode_uploadable_image` applies it as a row swap.
    bool invert_y = false;
    // `createImageBitmap({ premultiplyAlpha: "premultiply" })` followed by
    // `copyExternalImageToTexture({ premultipliedAlpha: true })` in the pin.
    // The shared decode path applies the same byte transform before upload.
    bool premultiply_alpha = false;
    // The pin's texture-OBJECT `invertY` property, a different thing from
    // the upload flip above: `loadTexture2D` results never carry the
    // property (its option only drives the flipped copy), so every image
    // texture a loader or compiled setter creates leaves this false. The
    // objects that do carry `invertY: true` are the ones whose pixels reach
    // the GPU un-flippable or already top-down — KTX2/Basis and
    // texture-array uploads, and colour render-target textures (rtt.ts;
    // depth RTTs carry false) — and `isStandardUvInverted`
    // (standard-pipeline.ts) reads exactly that property when it decides
    // the Standard UV transform's v flip. Scene 9's browser capture
    // carries `up = [1, 1, 0, 0]` for all 32 materials and Scene 24's for
    // 127 of 128, which is that property evaluating false over `.babylon`
    // textures.
    bool uv_invert_y = false;
    // A KTX container's or a transcoder's own blocks. Filled instead of
    // `bytes` rather than beside it: the blocks are what uploads, so
    // keeping the container file as well would carry the payload twice.
    CompressedTexture compressed{};

    /**
     * Whether this slot carries an image at all.
     *
     * An encoded file and `createTexture2DFromPixels` texels both land in
     * `bytes`; a compressed container's blocks land beside it. So every
     * "does this material have this texture" test asks here rather than
     * testing one field — a second predicate for the same fact is what
     * drifts.
     */
    bool has_image() const {
        return !bytes.empty() || !compressed.mips.empty();
    }
};

struct FileTexture {
    TextureData data{};
    bool srgb = false;
};

/**
 * A texture built from bytes the caller supplied (`pixels-texture.ts`).
 *
 * Unlike a file texture there is nothing to decode: the compiler baked the
 * module's own bytes, so these are the RGBA texels themselves and the size is
 * the caller's rather than an image header's.
 */
struct PixelsTexture {
    std::vector<std::uint8_t> rgba;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    TextureSamplerState sampler{};
    // The `Texture2D` properties a scene writes on the result before binding
    // it: the per-texture transform `enableMaterialUvTransform` reads, and
    // the texture-object `invertY` that both that transform and
    // `isStandardUvInverted` fold.
    TextureUvTransform uv_transform{};
    bool uv_invert_y = false;
};

struct ModelVertex {
    Vec3 position{};
    Vec3 normal{0.0f, 1.0f, 0.0f};
    Vec4 tangent{1.0f, 0.0f, 0.0f, 1.0f};
    Vec2 uv{};
    Vec2 uv2{};
    Vec3 local_position{};
    Vec4 color{1.0f, 1.0f, 1.0f, 1.0f};
    std::array<std::uint16_t, 4> joints{};
    Vec4 weights{};
};

// The flattened line-system geometry `createLineSystemData` produces: the
// concatenated points, one zero normal triple per vertex (the shared mesh
// uploader requires the buffer; the line shader binds no normal), the
// segment index pairs, the optional per-point RGBA, and the per-polyline
// point counts a later `updateLineSystem` validates against.
struct LineSystemData {
    std::vector<float> positions;
    std::vector<float> normals;
    std::vector<std::uint32_t> indices;
    std::vector<float> colors;
    std::vector<std::uint32_t> line_point_counts;
};

/**
 * Which space a geometry's `vertices[].position` lane is already in.
 *
 * `PrimitiveKind` does not answer this — it says whether a mesh has real
 * geometry rather than parametric dimensions, and `createPlane` and
 * `createMeshFromData` both record `gltf` while keeping local vertices.
 * A consumer that needs each vertex's world position has to compose what
 * is missing, so the producer records what it baked:
 *
 * - `local`: the builder's own vertices, with the node transform still on
 *   the `MeshRecord` (every factory mesh).
 * - `world`: the glTF loader's static arm, which multiplied each position
 *   through the mirrored node world before storing it.
 * - `mirrored_local`: the glTF loader's animated and instanced arms, which
 *   apply the RH-to-LH mirror but leave the node matrix for the draw.
 */
enum class VertexSpace : std::uint8_t {
    local,
    world,
    mirrored_local,
};

/**
 * A primitive's own topology, as the pin's own index
 * (`pbr-primitive-topology.ts`: 1 points, 2 lines, 3 line-strip).
 *
 * A triangle strip is not an enumerator because the loader expands one into
 * the triangle list it describes -- the single non-triangle mode that has an
 * exact triangle-list spelling. `gltf-feature-primitive.ts` keeps the index
 * on the mesh as a ready-made `GPUPrimitiveState`; here it rides the
 * geometry, because that is the record the loader fills and the render plan
 * copies from.
 */
enum class MeshTopology : std::uint8_t {
    triangles,
    points,
    lines,
    line_strip,
};

struct ModelGeometry {
    std::vector<ModelVertex> vertices;
    std::vector<ModelVertex> bind_vertices;
    std::vector<std::vector<Vec3>> morph_positions;
    std::vector<std::vector<Vec3>> morph_normals;
    std::vector<std::vector<Vec3>> morph_tangents;
    std::vector<std::uint32_t> indices;
    VertexSpace vertex_space = VertexSpace::local;
    MeshTopology topology = MeshTopology::triangles;
    bool has_tangents = false;
    bool flat_normals = false;
    Vec3 bounds_min{};
    Vec3 bounds_max{};
    // Where the box above sits in the world. A static primitive bakes its
    // node transform into its vertices, so the two agree; an animated one
    // keeps local vertices and receives its node matrix per frame, which
    // leaves `bounds_*` local. Camera framing needs the world box either
    // way, so the loader records it separately.
    Vec3 world_bounds_min{};
    Vec3 world_bounds_max{};
};

/**
 * A scene-graph node with a TRS and children, the port's `TransformNode`.
 *
 * Upstream it is not its own type at all: `TransformNode` is a pure alias
 * for `SceneNode`, and `createTransformNode` delegates to
 * `createSceneNode`, so a node carries exactly the transform lanes a mesh
 * carries and composes its local matrix through the same
 * `composeTrsLocalMatrix`. The field names match `MeshRecord` for that
 * reason: one emitted composition serves both.
 */
struct TransformNodeRecord {
    std::string name;
    Vec3d position{};
    Vec3 rotation{};
    Vec4 rotation_quaternion{0.0f, 0.0f, 0.0f, 1.0f};
    bool has_rotation_quaternion = false;
    Vec3 scaling{1.0f, 1.0f, 1.0f};
    /** The node this one hangs under, or none — `IParentable.parent`. */
    TransformNodeHandle parent{};
    /**
     * The traversal list `node.children` holds. Upstream a direct
     * `child.parent = node` write drives the transform math and leaves
     * `children` alone, so the two are recorded apart here as well.
     */
    std::vector<MeshHandle> children;
    /**
     * What the parent SETTER registered, which is the pin's own
     * `_addChild`: the list `invalidate()` recurses into when this node's
     * transform is marked dirty. Kept apart from `children` because
     * upstream keeps them apart -- a scene may write the link without
     * ever pushing the traversal entry, and the transform must still
     * follow.
     */
    std::vector<MeshHandle> parented_meshes;
    std::vector<TransformNodeHandle> parented_nodes;
    /** Bumped by every transform write, which is what re-bakes a child. */
    std::uint64_t transform_version = 0;
};

struct MeshRecord {
    /**
     * The pinned Mesh name: the factory literal (`"sphere"`, `"box"`, …),
     * the caller's string for createMeshFromData, the glTF loader's
     * `json.meshes[node.mesh].name || gltf_mesh_<i>`, or whatever the
     * scene assigned. Scene code finds meshes by it.
     */
    std::string name;
    PrimitiveKind primitive = PrimitiveKind::box;
    // The pin holds a node's translation as three JavaScript numbers, and
    // at large-world coordinates the float32 ULP is half a unit -- enough
    // to move a silhouette before the eye-relative subtraction can recover
    // anything. Rotation and scaling stay float: they are small by
    // construction and every consumer reads them at that width.
    Vec3d position{};
    Vec3 rotation{};
    Vec4 rotation_quaternion{0.0f, 0.0f, 0.0f, 1.0f};
    Vec3 scaling{1.0f, 1.0f, 1.0f};
    Vec3 dimensions{1.0f, 1.0f, 1.0f};
    // `mesh.receiveShadows`. A composition key for the Standard and PBR
    // families, whose variants carry the sampling code -- and a per-draw
    // VALUE for the node family, whose receiver mixes its factor by the
    // `meshU.receivesShadow` lane instead. One record field serves both:
    // the two composed families never read it.
    bool receives_shadows = false;
    // Scene-code boundMin/boundMax replace the corresponding object-local
    // bound carried by the pinned Mesh. Keep each side optional because the
    // public object permits either property to be assigned independently.
    bool has_bounds_min_override = false;
    bool has_bounds_max_override = false;
    Vec3 bounds_min_override{};
    Vec3 bounds_max_override{};
    /**
     * `IParentable.parent`: the node whose world matrix this mesh composes
     * under. Upstream any entity may parent to any other; the reached
     * slice is a mesh under a transform node.
     */
    TransformNodeHandle transform_parent{};
    /**
     * The mesh parent installed by `setParent`, plus the public traversal
     * list that function keeps in sync. Mesh and transform-node handles live
     * in different native tables, so retaining both identities avoids an
     * ambiguous integer handle while covering the pin's shared SceneNode
     * parent surface.
     */
    MeshHandle parent{};
    std::vector<MeshHandle> children;
    /** The world-matrix state's private child registry for dirty pushes. */
    std::vector<MeshHandle> parented_meshes;
    /**
     * Runtime simulation moves this hierarchy every frame. Its immutable
     * local vertices stay on the GPU and the renderer supplies the live
     * world matrix per draw instead of rebaking and re-uploading them.
     */
    bool gpu_world_transform = false;
    MaterialHandle material{};
    std::uint32_t geometry = invalid_handle;
    // A clone shares its source mesh's pinned shader composition. Generated
    // variant tables are creation-ordered and therefore end at the meshes
    // known during generation; this indirection keeps a later clone on the
    // exact attribute row its source uses instead of falling through to the
    // unrelated scene-builder fallback.
    std::uint32_t feature_source_mesh = invalid_handle;
    // A cloned imported root remains an outer scene-node transform. Unlike
    // ordinary mesh TRS this is applied by the draw world after deformation,
    // matching a clone whose mesh retains the source skeleton/morph resource.
    Vec3 outer_position{};
    float baked_world_scale = 1.0f;
    std::uint64_t transform_version = 0;
    bool has_rotation_quaternion = false;
    bool gpu_deformation = false;
    /**
     * Whether this mesh's bone palette rides the pin's own per-bone
     * texture (a composed skeleton variant) rather than the 64-matrix
     * uniform array. The transcribed vertex stage cannot read a palette
     * that large, so the block it would read is left at the identity and
     * the draw takes its deformation from the pinned stage instead.
     */
    bool pinned_bone_palette = false;
    bool clockwise_front_face = false;
    /**
     * Whether the mirrored-mesh watcher has seen this mesh, which is what
     * separates "its sign flipped" from "it was just added": the sign
     * itself is `clockwise_front_face` beside it.
     *
     * The pin keeps this per SCENE, because one mesh may belong to several
     * and a shared record would let the first scene's rebuild hide the flip
     * from the others. No reached scene shares a mesh, so it rides the
     * record here; a scene that did would need the per-scene map.
     */
    bool mirrored_seen = false;
    // Whether the loader stored this mesh's vertices through the native X
    // mirror. Babylon composes its own vertex stage against unmirrored data and
    // carries the mirror in the mesh block's world matrix, so a PAL binding
    // those stages needs the sign to convert between the two.
    bool mirrored_x = false;
    // Optional Mesh.renderOrder. The pinned renderer supplies its family
    // default only when this field was never assigned.
    bool has_render_order = false;
    double render_order = 0.0;
    // Self-visibility (scene-node.ts `visible?: boolean`, undefined = true).
    // No PICK path consults it -- `gpu-picker.ts` filters on `pickable`
    // alone -- which is the mirror of `pickable` below, and why the render
    // plan keeps a hidden mesh and only its draw lists drop one.
    // Written by scene code and by glTF KHR_node_visibility, which
    // materializes the cascade per mesh the way the pinned
    // `setSubtreeVisible` materializes it per node: the extension cascades
    // through the subtree at set time so the render path and the camera
    // bounds only test one boolean.
    bool visible = true;
    // mesh.ts `pickable?: boolean`, undefined = pickable. Read only by the
    // generated `pick_candidate`, which both backends' pick passes ask; no
    // draw path consults it, because a non-pickable mesh still renders.
    bool pickable = true;
    std::vector<std::array<float, 16>> bone_matrices;
    std::array<float, 16> instance_parent_matrix{
        1.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 1.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 1.0f, 0.0f,
        0.0f, 0.0f, 0.0f, 1.0f,
    };
    std::vector<std::array<float, 16>> instance_matrices;
    // Thin-instance pool state mirroring the pinned ThinInstanceData:
    // instance_matrices holds the fixed capacity pool, instance_count is
    // the active draw count, and instance_version gates the PAL re-upload
    // exactly like morph_weights_version. instance_source aliases the
    // caller's matrix array bound by set_thin_instances; the compiler only
    // accepts named bindings there, and generated main keeps every such
    // binding alive for the whole frame loop, so the pointer cannot
    // dangle. Loader-built instancing (glTF EXT_mesh_gpu_instancing)
    // leaves it null and never bumps the version.
    bool thin_instanced = false;
    std::uint32_t instance_count = 0;
    std::uint64_t instance_version = 0;
    const std::vector<float>* instance_source = nullptr;
    // The per-instance RGBA stream `setThinInstanceColors` bound, as the
    // pin's own tightly-packed float4 rows. Empty where the mesh has none.
    std::vector<float> instance_colors;
    // `Mesh._linePointCounts`: the polyline sizes a line system was built
    // from, kept because `updateLineSystem` refuses a changed connectivity
    // rather than rewriting a mesh whose segments moved. The flag beside it
    // is the pin's own `mesh._gpu.colorBuffer` test: an update cannot give
    // a line system colours it was not created with.
    std::vector<std::uint32_t> line_point_counts;
    bool line_has_colors = false;
    std::array<float, 4> morph_weights{};
    // Uncapped weights for the storage-buffer morph path; versioned so
    // PAL re-uploads only when the animation evaluator writes them.
    std::vector<float> morph_storage_weights;
    std::uint64_t morph_weights_version = 0;
};

// ---------------------------------------------------------------------------
// Sprites (src/sprite/*). A sprite layer is pure data upstream and stays pure
// data here: the Index API writes floats into one interleaved instance buffer
// and the renderer draws it. None of it touches the scene renderer -- a
// `SpriteRenderer` is its own rendering context on the engine, exactly as the
// pinned one is.
// ---------------------------------------------------------------------------

/** shared/sprite-atlas.ts `SpriteFrame`: UVs in [0,1], size in pixels. */
struct SpriteFrame {
    Vec2 uv_min{};
    Vec2 uv_max{};
    Vec2 source_size_px{};
    Vec2 pivot{0.5f, 0.5f};
};

struct SpriteAtlasRecord {
    // Decoded at load, because `createGridSpriteAtlas` partitions the
    // texture it was handed and so needs its size before any frame exists.
    std::vector<std::uint8_t> rgba;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    std::vector<SpriteFrame> frames;
    bool premultiplied_alpha = false;
    // `loadTexture2D`'s own `mipMaps`, as the loader that built this atlas
    // passed it: `loadSpriteAtlas` turns the chain off, and the atlas a
    // particle graph's texture block builds leaves it on. The PALs upload
    // the chain this says rather than inferring one from the sampler.
    bool mip_maps = false;
    TextureSamplerState sampler{};
    bool has_render_texture = false;
    SpriteRenderTextureHandle render_texture{};
};

struct SpriteRenderTextureRecord {
    std::uint32_t width = 0;
    std::uint32_t height = 0;
};

/**
 * A WebGPU `GPUCompareFunction`, as this runtime's own enumerator.
 *
 * The pin writes the WebGPU spelling; `pinned-depth-state.ts` maps it here
 * and fails generation on a spelling with no enumerator, so a backend
 * translates an enum rather than re-typing the pin's string.
 */
enum class DepthCompare {
    never,
    less,
    equal,
    less_equal,
    greater,
    not_equal,
    greater_equal,
    always,
};

/** blend-descriptors.ts / sprite-blend.ts, as the pure data they are. */
enum class SpriteBlendFactor {
    zero,
    one,
    src_alpha,
    one_minus_src_alpha,
    dst,
    dst_alpha,
};

struct SpriteBlendComponent {
    SpriteBlendFactor src = SpriteBlendFactor::one;
    SpriteBlendFactor dst = SpriteBlendFactor::zero;
};

/**
 * billboard-blend.ts `_depthMode`: which depth path a mode selects.
 * `transparent` blends without writing depth and is sorted far to near;
 * `cutout` discards below the alpha cutoff, writes depth, and draws with the
 * opaque meshes instead, so the GPU resolves overlap and no sort is needed.
 */
enum class BillboardDepthMode {
    transparent,
    cutout,
};

struct SpriteBlendDescriptor {
    // `_descriptor` absent upstream means no colour blend at all.
    bool enabled = true;
    // Only the billboard family declares one; the 2D descriptors leave it
    // at the transparent default, which is the path they all take.
    BillboardDepthMode depth_mode = BillboardDepthMode::transparent;
    SpriteBlendComponent color{};
    SpriteBlendComponent alpha{};
    // `_premultipliedOpacity`: per-layer opacity scales RGB as well as A.
    bool premultiplied_opacity = false;
    // `_particlePasses`: the exact Babylon.js particle blends, and the one
    // field only `particle-blend.ts` ever sets. Zero is every public
    // descriptor; one is Multiply, which draws the pin's own private
    // fragment; two is MultiplyAdd, which draws that pass and then a stock
    // Add pass over the same instances. The count rides the descriptor
    // because that is where upstream puts it -- the registrar forks on
    // `blendMode._particlePasses`, never on the numeric mode.
    int particle_passes = 0;
};

/** sprite-2d.ts `Sprite2DView`. Identity is a pixel-perfect HUD. */
struct Sprite2DView {
    Vec2 position_px{};
    float zoom = 1.0f;
    float rotation = 0.0f;
};

/**
 * A Gaussian-splat cloud, as `loadSplat` leaves it.
 *
 * The four RGBA32F payloads and the centres are what
 * `upstream::build_splat_geometry` produced from the packaged row buffer;
 * the backends upload the payloads once and re-run the sort whenever the
 * view-depth transform drifts, which is `postSplatSortIfDirty`'s rule.
 *
 * The pin's own transform state rides here too: a splat mesh is a scene node
 * with position/rotation/scaling, and the world matrix multiplies into the
 * depth transform. No reached scene moves one, so the world stays identity
 * and the field exists to keep the depth kernel written the way the pin
 * writes it rather than folded away.
 */
struct SplatMeshRecord {
    /**
     * A cloud is a SceneNode upstream, so it carries the same name a mesh
     * does -- and a GPU pick resolves to that name, which is the only reader
     * this port has for it.
     */
    std::string name;
    std::uint32_t vertex_count = 0;
    std::uint32_t texture_width = 0;
    std::uint32_t texture_height = 0;
    std::array<float, 3> bound_min{};
    std::array<float, 3> bound_max{};
    /** Splat centres, flat XYZ — the sort's only geometry input. */
    std::vector<float> positions;
    std::vector<float> centers_rgba;
    std::vector<float> cov_a_rgba;
    std::vector<float> cov_b_rgba;
    std::vector<float> colors_rgba;
    // A GaussianSplattingMesh is a SceneNode upstream, so its world matrix
    // is composed from the same TRS every other node's is; the port keeps
    // the same field names because one emitted composition serves both.
    // `build_splat_world` is that composition, and there is no cached
    // matrix here for the same reason the sort has no dirty flag: both
    // re-derive from the record each frame. Scene code writes all three
    // lanes (scene 127 the position, scene 125 all of them before baking
    // them away).
    Vec3 position{};
    Vec3 rotation{};
    Vec4 rotation_quaternion{0.0f, 0.0f, 0.0f, 1.0f};
    bool has_rotation_quaternion = false;
    Vec3 scaling{1.0f, 1.0f, 1.0f};
    // The packaged 32-byte rows, retained only where a reached call reads
    // them back. Upstream keeps them on every cloud (`splatsData`, BJS
    // `keepInRam: true`), but the one entry point that consumes them here
    // is the transform bake, and they are half again the size of the four
    // float payloads above -- so the loader fills this where the scene
    // reaches `bakeCurrentTransformIntoVertices` and leaves it empty
    // otherwise, which is the same reach boundary every other generated
    // capability draws.
    std::vector<std::uint8_t> rows;
};

struct Sprite2DLayerRecord {
    SpriteAtlasHandle atlas{};
    SpriteBlendDescriptor blend{};
    float opacity = 1.0f;
    bool visible = true;
    float order = 0.0f;
    Sprite2DView view{};
    Vec2 pivot{0.5f, 0.5f};
    std::uint32_t count = 0;
    std::uint32_t capacity = 0;
    // 13 for the pure-2D layout; the depth-hosted 14th slot is unreached.
    std::uint32_t instance_floats_per_sprite = 13;
    std::vector<float> instance_data;
    // The CPU-only shadow holding each sprite's true size regardless of
    // visibility, which is what makes hiding a free degenerate quad.
    std::vector<float> saved_size;
    // sprite-2d-uvscroll.ts: the first setSprite2DUvOffset widens the layout
    // by two floats per sprite and stashes the attribute the pipeline pushes.
    // A layer that never scrolls keeps the narrow layout and ships none of it.
    bool uv_scroll = false;
    // sprite-custom-shader.ts: a layer built with a descriptor draws the
    // composed program and binds the fx block beside its layer block. The
    // pin reaches both through a hook that is null until a descriptor
    // exists, so the flag is the same "is there one" question.
    std::uint32_t custom_shader = 0;
    // custom-shader-core.ts: the descriptor's extra textures, in the order
    // they bind after the atlas. Empty unless a custom shader named any.
    std::vector<PixelsTexture> custom_textures;
    // The `fx.params` vec4, zero until setSprite2DShaderParams writes it.
    Vec4 shader_params{};
    std::uint64_t version = 0;
};

/**
 * A world-space billboard system: an atlas, a packed instance buffer, and
 * the per-system uniforms. Unlike a 2D layer it carries no view of its own —
 * it draws inside the scene's pass against the scene camera and depth
 * buffer, which is what makes it occlude and be occluded by geometry.
 */
enum class BillboardOrientation {
    facing,
    axis_locked,
};

struct BillboardSystemRecord {
    SpriteAtlasHandle atlas{};
    BillboardOrientation orientation = BillboardOrientation::facing;
    BillboardDepthMode depth_mode = BillboardDepthMode::transparent;
    // setAlphaToCoverage: immutable pipeline state, so it is read when the
    // pass is built rather than per frame.
    bool alpha_to_coverage = false;
    SpriteBlendDescriptor blend{};
    float opacity = 1.0f;
    bool visible = true;
    // Zero for a facing system: the facing basis reads the camera instead.
    Vec3 axis{};
    float alpha_cutoff = 0.0f;
    std::uint32_t count = 0;
    // Incremented whenever the active packed instance rows change. Count is
    // not a sufficient upload stamp: a dynamic system may clear and refill
    // the same number of sprites with different positions or atlas frames.
    std::uint64_t instance_version = 0;
    std::uint32_t capacity = 0;
    std::uint32_t instance_floats_per_sprite = 16;
    std::vector<float> instance_data;
    // The mode-4 second pass's blend; see BillboardSystemOptions.
    SpriteBlendDescriptor add_pass_blend;
    // billboard-custom-shader.ts: the same opt-in the 2D layer carries --
    // a system built with a descriptor draws the composed program and
    // binds the fx block beside its system block.
    std::uint32_t custom_shader = 0;
    // custom-shader-core.ts: the descriptor's extra textures, in the order
    // they bind after the atlas. Empty unless a custom shader named any.
    std::vector<PixelsTexture> custom_textures;
    // The `fx.params` vec4, zero until setBillboardShaderParams writes it.
    Vec4 shader_params{};
};

struct SpriteRendererRecord {
    std::vector<Sprite2DLayerHandle> layers;
    Color4 clear_value{0.0f, 0.0f, 0.0f, 1.0f};
    bool clear = true;
    // `disposeSpriteRenderer` is idempotent upstream and every entry point
    // it owns checks this first, so the flag is the pin's own state rather
    // than a native lifetime device.
    bool disposed = false;
    // Bumped whenever the layer list itself changes (add / remove / dispose).
    // Each backend builds one `SpriteLayerGpu` per layer, indexed positionally
    // against this vector, so a changed list has to rebuild that pass -- the
    // same version-compare shape `mesh_membership_version` already gives a
    // scene whose mesh set moved.
    std::uint64_t layers_version = 0;
    bool has_target = false;
    SpriteRenderTextureHandle target{};
};

/**
 * A texture an effect samples, under the binding name it was set by.
 *
 * `setEffectTexture` stores the handle on the slot the name owns
 * (`effect-renderer.ts` `findTextureSlot`), so the name travels here for the
 * same reason it does for a node material: which binding a name lands on is
 * the descriptor's answer, and the two are joined where the pin joins them.
 * The reached slice binds a `createSolidTexture2D` 1x1 texel, which is why
 * the slot holds a colour rather than image bytes.
 */
struct EffectTextureSlot {
    std::string name;
    SolidTexture texture{};
    bool set = false;
};

/**
 * One `EffectWrapper`: which composed module it draws and what fills the
 * bind group the descriptor declared.
 *
 * The module, the layout and the pipeline state were settled at generation
 * (`upstream::effect_variants`), so what a record carries is only the two
 * things a scene writes after creation -- the uniform bytes and the bound
 * textures.
 */
struct EffectWrapperRecord {
    std::uint32_t variant = 0;
    /** The bytes `setEffectUniforms` wrote into the first uniform slot. */
    std::vector<float> uniform_values;
    /**
     * Set by `setEffectUniforms`, cleared once a backend that owns a uniform
     * buffer has written it -- the same split the post-process passes use
     * between mutating a parameter and uploading the block. SDL_GPU pushes
     * per command buffer and cannot skip; Dawn can.
     */
    bool uniforms_dirty = false;
    std::vector<EffectTextureSlot> textures;
};

/** An `EffectRenderer`: one wrapper drawn to the swapchain each frame. */
struct EffectRendererRecord {
    EffectWrapperHandle effect{};
    bool clear = false;
    Color4 clear_color{};
};

/** The options `createEffectRenderer` takes past the wrapper itself. */
struct EffectRendererOptions {
    bool clear = false;
    Color4 clear_color{};
};

struct PropertyAnimationKey {
    float time = 0.0f;
    std::array<float, 4> value{};
};

struct PropertyAnimationTrack {
    PropertyAnimationPath path = PropertyAnimationPath::position;
    PropertyAnimationComponent component =
        PropertyAnimationComponent::whole_lane;
    PropertyAnimationInterpolation interpolation =
        PropertyAnimationInterpolation::linear;
    /**
     * `createPropertyAnimationClip`'s own rotation-channel derivation,
     * which is what `evaluateSampler` slerps on — the path decides it
     * there too, but the flag is what the evaluator reads.
     */
    bool quaternion = false;
    std::vector<PropertyAnimationKey> keys;
};

struct PropertyAnimationClip {
    std::string name;
    std::vector<PropertyAnimationTrack> tracks;
    float duration = 0.0f;
    float frame_rate = 60.0f;
};

struct PropertyAnimationGroupRecord {
    PropertyAnimationTarget target{};
    PropertyAnimationClip clip;
    float from_time = 0.0f;
    float to_time = 0.0f;
    float current_time = 0.0f;
    float speed_ratio = 1.0f;
    bool loop = true;
    bool playing = true;
    /** `AnimationGroup.weight`: the mixer's contribution, default 1. */
    float weight = 1.0f;
};

using PropertyAnimationGroup =
    std::shared_ptr<PropertyAnimationGroupRecord>;

/**
 * One blended property, the pin's own weighted-mixer bucket. Upstream
 * keys it by the (object, property name) pair each runtime track
 * resolved; a lowered track names the same pair as its target, its lane
 * and the component of it the path selected — `position` lands on the
 * mesh while `position.x` lands on the position vector, so the two are
 * distinct pairs there and distinct keys here. How wide the bucket is
 * follows from the same triple, which is why the pin's mismatched-arity
 * throw has nothing to catch on this side.
 */
struct PropertyAnimationBucket {
    PropertyAnimationTarget target{};
    PropertyAnimationPath property =
        PropertyAnimationPath::position;
    PropertyAnimationComponent component =
        PropertyAnimationComponent::whole_lane;
    std::array<float, 4> values{};
    /** The track's own rotation-channel flag, as the pin's bucket keeps it. */
    bool quaternion = false;
    bool contested = false;
    bool active = false;
    bool has_reference = false;
    std::array<float, 4> reference{
        0.0f, 0.0f, 0.0f, 1.0f};
};

/**
 * One clip a manager blends this tick, as the weighted glTF mixer reads
 * it: which clip of the owning asset, and at what weight. The clip state
 * lives inside the asset's own animation runtime, so the manager hands
 * the list across rather than reaching into it.
 */
struct BlendedClip {
    std::size_t clip = 0;
    float weight = 1.0f;
};

/**
 * Which handler a manager's animation-group category has installed.
 * `setAnimationTaskCategoryHandler` keeps one slot, so the second opt-in
 * replaces the first rather than composing with it.
 */
enum class AnimationCategoryHandler {
    none,
    property_mixer,
    gltf_mixer,
};

struct PropertyAnimationManagerRecord {
    std::vector<PropertyAnimationGroup> groups;
    /**
     * The glTF groups `addAnimationGroups` attached, in attach order.
     * Upstream keeps them in the manager's own `_animationGroups` list and
     * ticks each through its controller; the clips themselves live in the
     * owning asset's runtime, so the handle is what travels here.
     */
    std::vector<AnimationGroupHandle> gltf_groups;
    bool started = false;
    /** Installed by `enablePropertyAnimationBlending` / `enableAnimationBlending`. */
    AnimationCategoryHandler category_handler =
        AnimationCategoryHandler::none;
    /** The mixers' per-manager scratch, upstream's `scratchByManager`. */
    std::vector<PropertyAnimationBucket> buckets;
    std::vector<BlendedClip> blend_scratch;
};

using PropertyAnimationManager =
    std::shared_ptr<PropertyAnimationManagerRecord>;

struct PropertyAnimationGroupOptions {
    float from_time = 0.0f;
    float to_time = 0.0f;
    float speed_ratio = 1.0f;
    bool loop = true;
};

// KHR_texture_transform is per texture slot upstream: gltf-ext-uv-transform.ts
// attaches uScale/vScale/uOffset/vOffset/uAng to each texture wrapper, and each
// sample computes its own UV from that wrapper's fields, so two slots on one
// material may carry different transforms.
struct TextureTransform {
    float u_scale = 1.0f;
    float v_scale = 1.0f;
    float u_offset = 0.0f;
    float v_offset = 0.0f;
    float rotation = 0.0f;
};

struct MaterialRecord {
    Color3 diffuse_color{};
    Color4 base_color_factor{1.0f, 1.0f, 1.0f, 1.0f};
    // Babylon keeps the material-wide alpha separate from the PBR base-color
    // factor. The fragment multiplies both when the factor field is composed.
    float alpha = 1.0f;
    Color3 emissive_factor{0.0f, 0.0f, 0.0f};
    // `KHR_materials_emissive_strength` folds into the factor above at load,
    // so animating either one needs both kept apart: the fragment reads the
    // product, and a pointer track rewrites whichever half it targets.
    Color3 emissive_base_factor{0.0f, 0.0f, 0.0f};
    float emissive_strength = 1.0f;
    Color3 specular_color{1.0f, 1.0f, 1.0f};
    Color3 ambient_color{};
    float specular_power = 64.0f;
    float diffuse_level = 1.0f;
    float opacity_level = 1.0f;
    float ambient_level = 1.0f;
    float diffuse_u_scale = 1.0f;
    float diffuse_v_scale = 1.0f;
    float diffuse_u_offset = 0.0f;
    float diffuse_v_offset = 0.0f;
    // Per-slot glTF texture transforms. Occlusion carries its own because the
    // pin's own occlusion carrier does: `buildDefaultPbrTexturesExt` wraps the
    // occlusion textureInfo separately from the metallic-roughness one, so a
    // material whose occlusion slot declares a transform of its own samples at
    // `occlUV` while the ORM slot keeps `ormUV`. Identical for every corpus
    // material that reaches both, and the pinned pointer registry still maps an
    // animated occlusion transform onto the ORM wrapper.
    TextureTransform base_color_transform{};
    TextureTransform orm_transform{};
    TextureTransform occlusion_transform{};
    TextureTransform normal_transform{};
    TextureTransform emissive_transform{};
    TextureTransform clearcoat_transform{};
    TextureTransform clearcoat_roughness_transform{};
    TextureTransform clearcoat_normal_transform{};
    TextureTransform sheen_transform{};
    TextureTransform sheen_roughness_transform{};
    TextureTransform iridescence_transform{};
    TextureTransform iridescence_thickness_transform{};
    TextureTransform transmission_transform{};
    TextureTransform thickness_transform{};
    std::uint32_t diffuse_coord_index = 0;
    std::uint32_t specular_coord_index = 0;
    std::uint32_t ambient_coord_index = 0;
    float metallic_factor = 1.0f;
    float roughness_factor = 1.0f;
    float direct_intensity = 1.0f;
    float environment_intensity = 1.0f;
    // Pinned default: the dielectric F0 the PBR material seeds (0.04).
    float reflectance = 0.04f;
    // KHR_materials_specular, through the pinned dielectric reflectance ext:
    // specularFactor scales the dielectric F0 and its grazing weight, and
    // specularColorFactor tints the dielectric reflectance. The fragment reads
    // them as metallicF0Factor / specularWeight / metallicReflectanceColor and
    // composes `dielectricF0 = reflectance * metallicF0Factor`, so the factor
    // is kept apart from the base reflectance rather than folded into it.
    bool has_metallic_reflectance = false;
    float metallic_f0_factor = 1.0f;
    float specular_weight = 1.0f;
    Color3 metallic_reflectance_color{1.0f, 1.0f, 1.0f};
    float normal_texture_scale = 1.0f;
    float transmission_factor = 0.0f;
    // Pinned default: gltf-ext-dielectric.ts treats ior 1.5 as neutral.
    float index_of_refraction = 1.5f;
    float thickness = 0.0f;
    bool use_thickness_as_depth = false;
    Color3 attenuation_color{1.0f, 1.0f, 1.0f};
    float attenuation_distance = 1.0f;
    float dispersion = 0.0f;
    bool has_subsurface = false;
    float subsurface_intensity = 1.0f;
    Color3 subsurface_color{1.0f, 1.0f, 1.0f};
    Color3 subsurface_diffusion_distance{1.0f, 1.0f, 1.0f};
    float subsurface_minimum_thickness = 0.0f;
    float subsurface_maximum_thickness = 1.0f;
    float clearcoat_intensity = 0.0f;
    float clearcoat_roughness = 0.0f;
    // Pinned default: the coat ior the clearcoat layer seeds.
    float clearcoat_index_of_refraction = 1.5f;
    float clearcoat_normal_scale = 1.0f;
    Color3 sheen_color{0.0f, 0.0f, 0.0f};
    float sheen_roughness = 0.0f;
    float sheen_intensity = 1.0f;
    // KHR_materials_anisotropy / `setPbrAnisotropy`. The direction is the
    // pin's own `direction ?? [1, 0]`, written beside the intensity into
    // `anisotropyParams` by the extension's own writer.
    float anisotropy_intensity = 1.0f;
    Vec2 anisotropy_direction{1.0f, 0.0f};
    bool has_anisotropy = false;
    float iridescence_intensity = 0.0f;
    // Pinned defaults: KHR_materials_iridescence ior 1.3, thickness
    // 100..400 nm (gltf-ext-iridescence.ts).
    float iridescence_index_of_refraction = 1.3f;
    float iridescence_minimum_thickness = 100.0f;
    float iridescence_maximum_thickness = 400.0f;
    bool has_ior = false;
    bool has_volume = false;
    bool skybox_mode = false;
    bool specular_aa = false;
    // `usePhysicalLightFalloff`, the pin's own default-true property. The
    // composed punctual arms carry both falloffs and select on the material
    // UBO's `lightFalloffMode`, which `_writeMaterialData` fills from here.
    bool use_physical_light_falloff = true;
    bool has_occlusion_texture = false;
    // glTF occlusionTexture.strength, which the fragment mixes toward 1. The
    // pin forces its reflectance ext on when this is animated so the mix
    // exists; ours is on the core path, so the value simply rides here.
    float occlusion_strength = 1.0f;
    bool unlit = false;
    bool no_color = false;
    /** Original material copied into a no-colour/ESM view. */
    MaterialHandle source_material{};
    /**
     * An ESM caster view: `createStandardEsmShadowMaterialView` clears the
     * blend bit and sets `ESM_SHADOW_OUTPUT`, so this view writes the
     * exponential depth into a colour attachment rather than nothing.
     */
    bool esm_shadow = false;
    /**
     * Which generator's caster block this view reads. `getEsmShadowView`
     * builds one view per material PER GENERATOR, closing over that
     * generator's own `_shadowParamsUBO`, so the bias and depth scale a
     * caster draw sees are its generator's.
     */
    ShadowGeneratorHandle esm_shadow_generator{};
    bool disable_lighting = false;
    bool has_emissive_render_texture = false;
    // `material.diffuseTexture = <createRenderTargetTexture output>`: the
    // Standard diffuse slot fed by another pass's colour attachment rather
    // than by decoded image bytes.
    bool has_diffuse_render_texture = false;
    // `enableMaterialUvTransform(material)`: the pin's own opt-in mark
    // (`_hasUvTx`), read back by `stdUvTransformExt._meshFeatures` and
    // therefore part of the composed variant key.
    bool has_uv_transform = false;
    // `material.plugins = [...]` on a STANDARD material: the per-signature
    // index the pin's own `registerStdPlugins` pre-bakes into the material's
    // cached `_renderFeatures`, from one, zero for a material carrying none.
    // Standard's feature computation is not extension-extensible, which is
    // why upstream bakes it and why it has to ride the record here — the
    // Standard variant key is the word `standard_material_features` derives.
    // The PBR family needs no such lane: its selector keys by material
    // index, so the composed row already carries the plugin.
    //
    // A byte, because the pin's own `PLUGIN_INDEX_MASK` reserves seven bits
    // for it: a wider field lands after the bool run below and pushes the
    // whole tail across an alignment boundary, costing eight bytes per
    // material rather than none. Generation refuses a mask this cannot hold.
    std::uint8_t plugin_signature_index = 0;
    bool double_sided = false;
    // The pin's opacityFromRGB (createStandardMaterial default false; the
    // .babylon loader sets it from opacityTexture.getAlphaFromRGB,
    // load-babylon.ts TEX_SLOTS opacity extra). Feeds OPACITY_FROM_RGB in
    // _computeStandardMaterialFeatures, which selects the composed opacity
    // fragment's dot(opSample.rgb, ...) luminance arm.
    bool opacity_from_rgb = false;
    bool standard_material = false;
    bool shader_material = false;
    // A Babylon NME graph, compiled at generation by the pin's own emitter.
    // Its variant rides `shader_variant` below, which indexes whichever
    // family's table the material belongs to.
    bool node_material = false;
    bool grid_material = false;
    bool alpha_to_coverage = false;
    bool shader_alpha_testing = false;
    bool shader_depth_write = true;
    // Index into the material family's own generated variant table -- the
    // shader-variant one (`upstream::shader_variant_info`) or, for a node
    // material, `upstream::node_variants`. Ids are assigned in reach order
    // by the compiler and drive pipeline selection and uniform layout.
    std::uint32_t shader_variant = 0;
    // Flat custom-uniform storage laid out by the variant's reflected
    // member offsets; created (and defaults-applied) by the emitted
    // create_shader_material, written by the emitted offset setters.
    std::vector<float> shader_uniform_values;
    Color3 grid_main_color{0.0f, 0.0f, 0.0f};
    Color3 grid_line_color{0.0f, 0.5f, 0.5f};
    Vec4 grid_control{1.0f, 10.0f, 0.33f, 1.0f};
    Vec3 grid_offset{};
    float grid_visibility = 1.0f;
    bool grid_antialias = true;
    bool grid_pre_multiply_alpha = false;
    bool grid_use_max_line = false;
    MaterialAlphaMode alpha_mode = MaterialAlphaMode::opaque;
    float alpha_cutoff = 0.5f;
    TextureData base_color_texture;
    TextureData metallic_roughness_texture;
    TextureData metallic_reflectance_texture;
    TextureData reflectance_texture;
    TextureData normal_texture;
    /** KHR_materials_pbrSpecularGlossiness: RGB specular, A glossiness. */
    TextureData spec_gloss_texture;
    TextureData transmission_texture;
    TextureData thickness_texture;
    TextureData clearcoat_texture;
    TextureData clearcoat_roughness_texture;
    TextureData clearcoat_normal_texture;
    TextureData sheen_color_texture;
    TextureData sheen_roughness_texture;
    TextureData iridescence_texture;
    TextureData iridescence_thickness_texture;
    TextureData emissive_texture;
    TextureData opacity_texture;
    TextureData specular_texture;
    TextureData ambient_texture;
    // Standard bump map. The pinned fragment builds a cotangent frame from
    // screen-space derivatives, so no tangent attribute is involved, and it
    // scales the interpolated normal by 1 / level before the frame is built.
    TextureData bump_texture;
    float bump_scale = 1.0f;
    // Dedicated glTF occlusion texture sampled at uv2 (Babylon Lite's
    // pbr-template-ext pair for occlusionTexture.texCoord == 1).
    TextureData occlusion_texture;
    bool occlusion_texture_uv2 = false;
    // Texture-less base color baked to the pinned 8-bit sRGB texel
    // (uploadBaseColorFactorTexture); the hardware decode of these
    // bytes is the browser's effective base color.
    std::array<std::uint8_t, 4> base_color_fallback{
        255, 255, 255, 255};
    // The base-colour slot's own texture FORMAT, which upstream keeps on the
    // `Texture2D` rather than on the material: `loadTexture2D` picks
    // `rgba8unorm-srgb` or `rgba8unorm` from its caller's `srgb` option
    // (texture-2d.ts), and the glTF loader passes true for this slot
    // (gltf-pbr-builder.ts) as does the texture-less factor bake, which
    // writes an sRGB texel. False for a scene-code solid texture -- the pin's
    // createSolidTexture2D writes its rounded texel into a 1x1 rgba8unorm
    // sampled without decode -- and false for a `loadTexture2D` result the
    // scene did not ask sRGB for, which is how a gamma-albedo material feeds
    // the decode to its own fragment instead.
    bool base_color_srgb = true;
    // Set by the loader's whiteFallback path: an animated base colour factor
    // on an image-less material bakes a white texel and keeps the live factor
    // in the record for the pointer writer. The pin seeds `mat.alpha` from
    // the factor it ASSEMBLES with -- the white one -- so the pinned
    // materialAlpha lane holds 1 whatever the animated alpha does.
    bool animated_base_color = false;
    // Texture-less metallic/roughness baked to the pinned 8-bit texel
    // (uploadOrmFactorTexture writes [255, roughness, metallic, 255]) with the
    // uniform factors left at one. Keeping the factor in the texel rather than
    // the uniform is what makes an animated factor behave: the pointer writer
    // multiplies the uniform against this texel, so a baked zero stays zero.
    std::array<std::uint8_t, 4> orm_fallback{255, 255, 255, 255};
    RenderTextureRef emissive_render_texture{};
    RenderTextureRef diffuse_render_texture{};
    // The material's own texture slots, in the order the family's variant
    // table declares them: a shader material's `samplers` (`_textureSlots`
    // upstream), or a node graph's `TextureBlock`/`ImageSourceBlock`
    // bindings resolved against the scene's `textures` record. Empty for
    // every other family, and for a program that samples nothing.
    std::vector<FileTexture> shader_textures;
    std::uint32_t reflection_cube = invalid_handle;
    float reflection_level = 1.0f;
    // The pin's 2D reflection slot: the non-cube arm of the same
    // reflectionTexture JSON slot the cube handle above consumes
    // (load-babylon.ts TEX_SLOTS reflectionTexture, `skipIf: isCube`),
    // sampled by the composed std-reflection fragment at computed
    // reflCoords rather than mesh UVs.
    TextureData reflection_texture;
    // writeStdMaterialData's rCm lane: createStandardMaterial seeds 1
    // (spherical, the fragment's `rCm < 1.5` arm); the pin's loader writes
    // 2 only for coordinatesMode === 2 (planar), load-babylon.ts.
    float reflection_coord_mode = 1.0f;
};

// The pin reads `mat.alpha < 1` live when it builds renderables, and the
// PBR transmission extension forces blending regardless of alpha, so the
// mode is a derivation of the two factors it is stored beside. One home
// for that rule: the factor-driven families (Standard, PBR) derive here at
// creation and at every alpha write; a shader, node, or grid material owns
// its mode through its variant flag or opacity control instead, and an
// alpha write leaves it with its factory. A glTF-authored mask mode is
// alpha-testing, not factor-driven, and likewise stays.
inline void derive_material_alpha_mode(MaterialRecord& material) {
    if (material.shader_material || material.node_material ||
        material.grid_material ||
        material.alpha_mode == MaterialAlphaMode::mask) {
        return;
    }
    material.alpha_mode =
        material.alpha < 1.0f ||
                material.transmission_factor > 0.0f
            ? MaterialAlphaMode::blend
            : MaterialAlphaMode::opaque;
}

struct LightRecord {
    LightKind kind = LightKind::directional;
    Vec3 position{};
    Vec3 direction{0.0f, 1.0f, 0.0f};
    float intensity = 1.0f;
    float range = std::numeric_limits<float>::max();
    // cos(angle/2) for a spot cone, which is what the pinned spot light packs
    // into its direction slot. glTF gives the half-angle directly as
    // spot.outerConeAngle, and the pinned loader doubles it into the full
    // cone angle the light stores, so the cosine of the half-angle is the
    // cosine of outerConeAngle.
    float cos_half_angle = 1.0f;
    /**
     * The full cone angle the cosine above was taken of, at the width the
     * pinned factory holds it (a JavaScript number). Shading reads only the
     * cosine; a spot PCF shadow projection reads the angle itself, as the
     * perspective FOV `_computeSpotLightMatrix` builds its volume from. It
     * is written wherever `cos_half_angle` is, so the two never disagree.
     */
    double angle = 0.0;
    // Spot falloff exponent. The pinned Standard lighting function raises the
    // cone cosine to it, so a higher value sharpens the edge. A glTF spot
    // carries no exponent and the PBR path shades cones by inverse-square
    // falloff instead, which never reads this.
    float exponent = 1.0f;
    Color3 diffuse_color{};
    Color3 specular_color{};
    Color3 ground_color{0.0f, 0.0f, 0.0f};
    std::array<float, 16> local_matrix{};
    // The meshes this light applies to, as the pinned engine keeps them: an
    // inclusion list wins outright when it is non-empty, otherwise the
    // exclusion list filters. Empty on both means every mesh, which is what
    // a light created in scene code gets.
    std::vector<std::uint32_t> included_meshes;
    std::vector<std::uint32_t> excluded_meshes;
    /**
     * `light.shadowGenerator`. The pin's `ShadowTask` walks `scene.lights`
     * and renders each light's generator, and `standard-renderable.ts`
     * collects the receiver slots from the same walk, so the generator
     * hangs off the light in both directions.
     */
    ShadowGeneratorHandle shadow_generator{};
};

// Every scalar the pinned camera factories hold is a plain JavaScript
// number, and `src/camera/camera.ts` reads them into the view and
// projection writers in that precision. The record therefore keeps
// doubles, and `camera_world_matrix` performs the single store the pinned
// `allocateMat4()` cache performs -- into float32 by default, and into
// float64 under the high-precision matrix a floating-origin engine asks
// for, which is the width `getViewMatrix` then reads the basis back at.
struct CameraRecord {
    CameraKind kind = CameraKind::arc_rotate;
    Vec3d position{};
    double alpha = -pi_double / 2.0;
    double beta = 1.1;
    double radius = 6.0;
    Vec3d target{};
    double fov = 0.8;
    double near_plane = 0.1;
    double far_plane = 1000.0;
    double inertia = 0.9;
    double panning_inertia = 0.9;
    double angular_sensibility = 1000.0;
    double speed = 2.0;
    double free_yaw = 0.0;
    double free_pitch = 0.0;
    double inertial_yaw_offset = 0.0;
    double inertial_pitch_offset = 0.0;
    Vec3d inertial_direction{};
    double panning_sensibility = 50.0;
    double wheel_precision = 3.0;
    double inertial_alpha_offset = 0.0;
    double inertial_beta_offset = 0.0;
    double inertial_radius_offset = 0.0;
    double inertial_panning_x = 0.0;
    double inertial_panning_y = 0.0;
    std::optional<double> lower_alpha_limit;
    std::optional<double> upper_alpha_limit;
    std::optional<double> lower_beta_limit;
    std::optional<double> upper_beta_limit;
    std::optional<double> lower_radius_limit;
    std::optional<double> upper_radius_limit;
    bool controls_enabled = false;
    // Orthographic projection state (src/camera/orthographic.ts). The
    // four clip planes stay derived from the half-extent, which is the
    // reached surface: vertically +/-half_height, horizontally scaled by
    // the render target's aspect ratio.
    bool orthographic = false;
    double ortho_half_height = 1.0;
    /**
     * The `_camera` glTF loader feature's naming: `def.name ?? camera<idx>`
     * on an imported camera, the record default (empty) on a scene-created
     * one — matching the pin, whose scene cameras leave `name` unset.
     */
    std::string name;
    /**
     * An imported glTF camera is the pin's FreeCamera parented under its
     * `<name>_fixup` transform: `getWorldMatrix` composes
     * `parent_world × local` through the pinned multiply, so the record
     * carries the fixup node's composed world. The loader writes it — once
     * for a baked (unreachable) node, per pose for a live one.
     */
    bool has_parent_world = false;
    std::array<float, 16> parent_world{};
};

struct Scene;
struct FrameGraphContext;

// One glTF animation as scene code addresses it, mirroring the group
// src/animation/animation-group.ts builds per clip. The play state lives with
// the clip inside the owning asset's runtime; this record carries what a scene
// reads and the coordinates the operations need to reach it.
struct AnimationGroupRecord {
    std::string name;
    std::uint32_t asset = invalid_handle;
    std::size_t clip = 0;
    /** `AnimationGroup.weight`: what the weighted mixer contributes it at. */
    float weight = 1.0f;
};

/**
 * One bone's local-transform override, the pin's own `BoneOverride`
 * (`src/skeleton/bone-control.ts`), at the slice this port reaches.
 *
 * Upstream the mask carries four bits and the record carries the
 * translation, rotation and scale each of the first three replaces.
 * `setBoneVisible` is the one lowered mutator here, so no override this
 * port can build carries anything but the hidden bit -- the lanes arrive
 * with the setters that fill them. The mask itself stays, because the
 * pin's own show arm is written on it: clear the bit, and drop the
 * override once the mask is empty.
 */
struct BoneOverride {
    std::uint32_t mask = 0;
};

/**
 * One joint node of a skeleton, in the skin's own `joints` order.
 *
 * `name` is the glTF node's name, or the pin's `bone_<nodeIndex>`
 * fallback; `node_index` is the key every override is stored under, which
 * is what makes an override reach across skins through the hierarchy.
 */
struct BoneRecord {
    std::string name;
    std::uint32_t node_index = 0;
};

/**
 * A skinned model's skeleton -- one per glTF skin instance, surfaced on
 * `AssetContainer.skeletons` once the scene reached `enableBoneControl`.
 *
 * The overrides themselves live on the owning asset, because upstream's
 * map is asset-wide and one bake refreshes every skinned mesh of the file.
 */
struct SkeletonRecord {
    std::uint32_t asset = invalid_handle;
    std::vector<BoneHandle> bones;
};

struct AssetRecord {
    std::vector<MeshHandle> meshes;
    std::vector<LightHandle> lights;
    /**
     * The cameras the `_camera` loader feature instantiated, one per
     * referencing glTF node in node order — `AssetContainer.cameras`.
     */
    std::vector<CameraHandle> cameras;
    // The synthetic root's own position for a hierarchy clone. The cloned
    // mesh records carry it as `outer_position`; this value preserves
    // absolute assignment and clone-of-clone semantics.
    Vec3 root_position{};
    CameraHandle camera{};
    Color4 clear_color{};
    bool has_camera = false;
    bool has_clear_color = false;
    std::function<void(float)> animation_tick;
    std::function<void(float)> animation_seek;
    /**
     * Registers a cloned mesh with the source asset's animation runtime.
     * Babylon Lite clones retain the same skeleton/morph resources, so a
     * hierarchy clone continues to receive the original controller's pose.
     */
    std::function<void(MeshHandle, MeshHandle)> clone_mesh_animation;
    /**
     * The weighted pass over the clips a manager attached, present only
     * when the scene reached `enableAnimationBlending`. Returns whether
     * it drove the tick — false hands it back to the per-clip advance,
     * which is the pin's own category-handler contract.
     */
    std::function<bool(const std::vector<BlendedClip>&, float)>
        animation_blend;
    /**
     * Advances exactly the clips a manager owns and re-evaluates the
     * asset, where `animation_tick` advances every clip the file holds
     * from one master clock. A manager-driven scene takes this one.
     */
    std::function<void(const std::vector<BlendedClip>&, float)>
        animation_tick_clips;
    std::function<void(Scene&)> scene_setup;
    /** This asset's clips, in the document's own animation order. */
    std::vector<AnimationGroupHandle> animation_groups;
    /** Sets one clip's isPlaying, through the loader's own runtime. */
    std::function<void(std::size_t, bool)> set_clip_playing;
    /** Sets one clip's _stopped, which decides whether a seek reaches it. */
    std::function<void(std::size_t, bool)> set_clip_stopped;
    /** Sets one clip's currentTime in seconds. */
    std::function<void(std::size_t, float)> set_clip_time;
    /**
     * Applies one clip at its stored time. The boolean is the pin's own
     * `engine` argument to `goToFrame`: without it a stopped glTF group's
     * controller is not ticked, with it the pose lands anyway.
     */
    std::function<void(std::size_t, bool)> apply_clip_pose;
    /** Sets one clip's loopAnimation, which the weighted mixer reads. */
    std::function<void(std::size_t, bool)> set_clip_loop;
    /** Sets one clip's speedRatio, which its own advance scales by. */
    std::function<void(std::size_t, float)> set_clip_speed_ratio;
    /**
     * Resolves one clip's AnimationGroupMask against the asset's node names
     * and stores the skip flags the channel walk reads (the pin's own
     * resolveAnimationMask).
     */
    std::function<
        void(std::size_t, const std::vector<std::string>&, bool)>
        set_clip_mask;
    // Marks one clip additive at its reference time (the pin's
    // `group._additive = { referenceTime }`); filled by the generated
    // loader only when the additive mixer is compiled in.
    std::function<void(std::size_t, float)> set_clip_additive;
    /**
     * `AssetContainer.skeletons`: the skeletons the opt-in bone-control
     * chunk built for this file, empty for every other scene.
     */
    std::vector<SkeletonHandle> skeletons;
    /**
     * The asset-wide overrides, one slot per glTF node -- the pin keys its
     * `_overrides` map by node index for the same reason, since a single
     * skin is often split across meshes and an override may reach across
     * skins through the hierarchy. A zero mask is an absent entry, which is
     * exactly what the pin's own `delete` leaves behind, and a dense table
     * is what makes its `size() > 0` gate structural: the bake walks these
     * nodes either way.
     */
    std::vector<BoneOverride> bone_overrides;
    /**
     * The pin's eager bake: recompute this file's node hierarchy from rest
     * plus overrides and refresh every skinned mesh's palette. Filled only
     * by a loader compiled with bone control.
     */
    std::function<void()> bake_skeletons;
};

/**
 * Which pinned generator built a shadow map.
 *
 * The two PCF arms share everything the receiver sees -- the same
 * `depth32float` map, the same comparison sampler, the same
 * `createShadowFragment` binding types -- and differ only in the projection
 * their light-space matrix is fitted with, which is why every consumer that
 * asks about a generator's RESOURCES tests for the ESM arm alone.
 */
enum class ShadowFilter {
    pcf_spot,
    /**
     * `createPcfDirectionalShadowGenerator`: the spot generator's own GPU
     * state over the ESM's caster-fitted orthographic volume, which is
     * exactly how the pin assembles it -- `renderPcfShadowMap` with
     * `computeDirectionalLightMatrix` as its matrix builder.
     */
    pcf_directional,
    esm_directional,
};

/**
 * One `ShadowGenerator`, as the three pinned factories build it.
 *
 * The pin keeps the GPU objects on the generator (a `depth32float` map, a
 * comparison sampler, the params UBO and the receiver UBO); those are the
 * PAL's, so the record carries only the values that decide them plus the
 * two matrices the refresh rebuilds — the unbiased one the receiver samples
 * with, and the biased one the caster pass renders through.
 */
struct ShadowGeneratorRecord {
    ShadowFilter filter = ShadowFilter::pcf_spot;
    std::uint32_t map_size = 512;
    double bias = 0.0;
    double darkness = 0.0;
    double near_plane = 1.0;
    double far_plane = 10000.0;
    /** `sg._lightMatrix` — unbiased, what the receiver samples with. */
    std::array<float, 16> light_matrix{};
    /** The shadow camera's view, from the pinned light-space basis. */
    std::array<float, 16> caster_view{};
    /** That camera's view-projection, with the pinned clip-space bias. */
    std::array<float, 16> caster_view_projection{};
    /** The `ShadowTask` inputs `setShadowTaskCasterMeshes` registered. */
    std::vector<MeshHandle> caster_meshes;
    /** The depth-only render task the task state built for this map. */
    TaskHandle task{};
    /** Source/view pairs retained while a dynamic caster list is filtered. */
    std::vector<MaterialHandle> caster_material_sources;
    std::vector<MaterialHandle> caster_material_views;
    /** ESM only: the two lanes the receiver block packs. */
    double depth_scale = 0.0;
    double frustum_edge_falloff = 0.0;
    /** ESM only: the ortho volume the caster fit projects into. */
    double ortho_min_z = 1.0;
    double ortho_max_z = 10000.0;
    /**
     * ESM only: this generator's ordinal among the ESM ones, which is the
     * row generation emitted its recorded resources under.
     */
    std::uint32_t esm_index = 0;
};

struct Engine {
    EngineOptions options{};
    /**
     * `stopEngine`: the pin cancels its animation frame and clears
     * `_renderFn`, so no further frame submits. There is no
     * `requestAnimationFrame` here -- the frame conductor IS the loop --
     * so the same thing is a flag it checks, and a stopped engine is one
     * the conductor leaves after finishing the frame in flight.
     */
    bool stopped = false;
    /**
     * The scene's own capture-readiness conditions, from a bounded
     * multi-frame drain. Every one must hold before a frame loop takes the
     * capture it was asked for.
     */
    std::vector<std::function<bool()>> capture_ready;
    /**
     * `setTimeout(callback, 0)`: callbacks queued to run once, after the
     * frame that queued them.
     *
     * Babylon Native, which embeds a JavaScript engine, needs a whole
     * `TimeoutDispatcher` for this -- a timer thread with a time-ordered
     * queue that marshals each due call back onto the JS thread. None of
     * that applies here: there is no second thread to marshal to and the
     * frame conductor is the only one. Seventeen of the corpus's
     * twenty-one `setTimeout` call sites pass a delay of exactly 0, so
     * the reached slice is a one-shot deferred queue the conductor drains
     * once per frame; the four real waits refuse at generation rather
     * than pretending this is a timer.
     */
    std::vector<std::function<void()>> deferred_callbacks;
    /**
     * Browser `setInterval` callbacks. They share the frame conductor's
     * double-precision monotonic clock and run at most once per frame; the
     * next due time still advances by whole periods so a late frame does not
     * introduce permanent drift. `clearInterval` marks an entry inactive,
     * including while another due callback is being drained.
     */
    struct IntervalCallback {
        std::uint64_t id = 0;
        double period_ms = 0.0;
        double next_due_ms = 0.0;
        std::function<void()> callback;
        bool active = true;
    };
    std::vector<IntervalCallback> interval_callbacks;
    std::uint64_t next_interval_id = 1;
    /** Input callbacks registered before the platform frame loop starts. */
    std::vector<std::function<void(const PlatformKeyboardEvent&)>>
        key_down_callbacks;
    std::vector<std::function<void(const PlatformKeyboardEvent&)>>
        key_up_callbacks;
    std::vector<std::function<void()>> pointer_down_callbacks;
    std::vector<std::function<void(const PlatformMouseEvent&)>>
        mouse_down_callbacks;
    std::vector<std::function<void(const PlatformMouseEvent&)>>
        mouse_up_callbacks;
    std::vector<std::function<void(bool)>> visibility_change_callbacks;
    /**
     * Application-owned `requestAnimationFrame` callbacks registered before
     * `startEngine`. Browser RAF callbacks run in registration order, so these
     * precede the engine-owned render callback.
     */
    std::vector<std::function<void(double)>> animation_frame_callbacks;
    /**
     * Application-owned RAF callbacks registered after `startEngine` has
     * resolved. The engine callback was registered first, so these run after
     * the frame has been submitted and can only affect the following frame.
     */
    std::vector<std::function<void(double)>>
        post_render_animation_frame_callbacks;
    /** The awaited start resolves only after the engine's initial render. */
    bool post_render_animation_frame_callbacks_armed = false;
    /** One double-precision DOMHighResTimeStamp shared by this RAF turn. */
    double animation_frame_timestamp_ms = 0.0;
    /**
     * Every animation manager created with this engine
     * (`createAnimationManager({ engine })`). A manager owns animation time
     * for the groups attached to it, so a measured seek has to reach it;
     * registering scenes attach one seeker per manager, the way an asset
     * added to a scene contributes its own.
     */
    std::vector<PropertyAnimationManager> animation_managers;
    std::vector<MeshRecord> meshes;
    std::vector<MaterialRecord> materials;
    std::vector<LightRecord> lights;
    std::vector<TransformNodeRecord> transform_nodes;
    std::vector<CameraRecord> cameras;
    std::vector<ModelGeometry> geometries;
    std::vector<std::array<TextureData, 6>> reflection_cubes;
    std::vector<AssetRecord> assets;
    std::vector<AnimationGroupRecord> animation_groups;
    std::vector<SkeletonRecord> skeletons;
    std::vector<BoneRecord> bones;
    std::vector<RenderTargetRecord> render_targets;
    std::vector<FrameTaskRecord> frame_tasks;
    RenderTargetHandle swapchain_target{};
    std::vector<Scene*> registered_scenes;
    std::vector<FrameGraphContext*> registered_frame_graph_contexts;
    std::vector<SpriteAtlasRecord> sprite_atlases;
    std::vector<Sprite2DLayerRecord> sprite_layers;
    std::vector<BillboardSystemRecord> billboard_systems;
    std::vector<SpriteRendererRecord> sprite_renderers;
    std::vector<SpriteRenderTextureRecord> sprite_render_textures;
    std::vector<SplatMeshRecord> splat_meshes;
    std::vector<EffectWrapperRecord> effect_wrappers;
    std::vector<EffectRendererRecord> effect_renderers;
    std::vector<ShadowGeneratorRecord> shadow_generators;
    std::vector<GpuPickerRecord> gpu_pickers;
    /**
     * The live renderer's pick pass.
     *
     * A pick renders the scene into a one-pixel target and reads it back,
     * which only the backend that owns the mesh buffers and the cloud's
     * textures can do. The renderer installs this during setup and the
     * generated `gpu_pick` calls it; a build whose loop has not started
     * yet -- or whose backend does not implement picking -- leaves it
     * empty and the pick reports a miss rather than shading something
     * plausible.
     */
    std::function<PickingInfo(GpuPickerHandle, double, double)> pick_hook;
    // `engine._renderingContexts`, for the sprite half: registration
    // order is draw order across renderers.
    std::vector<SpriteRendererHandle> registered_sprite_renderers;
    // The same list for the effect half; an effect renderer is its own
    // rendering context on the engine exactly as a sprite renderer is.
    std::vector<EffectRendererHandle> registered_effect_renderers;
};

struct EnvironmentState {
    bool has_irradiance = false;
    float exposure = 1.0f;
    float contrast = 1.0f;
    // Pinned: the DDS environment loader uses LOD generation scale 0.8
    // where the HDR loader uses 1.0 (load-dds-env.ts; docs/fidelity.md).
    float lod_generation_scale = 0.8f;
    float rotation_y = 0.0f;
    bool tone_mapping_enabled = false;
    std::array<Color3, 9> spherical_harmonics{};
    std::uint32_t specular_width = 0;
    std::uint32_t specular_mip_count = 0;
    std::vector<TextureData> specular_faces;
    bool specular_rgba16f = false;
    TextureData brdf_lut;
    std::uint32_t brdf_lut_width = 0;
    bool brdf_lut_rgba16f = false;
    TextureData ground_texture;
    TextureData skybox_texture;
    std::array<TextureData, 6> image_skybox_faces{};
    float image_skybox_size = 0.0f;
    bool has_image_skybox = false;
    bool has_ground = false;
    bool has_skybox = false;
    // src/loader-env/load-env.ts: the deferred builder pushes
    // buildSolidSkyboxRenderable whenever the scene names no DDS or .env
    // skybox and does not skip one. It shades from the clear colour and
    // shares nothing with the cubemap arms above.
    bool has_solid_skybox = false;
    bool background_enabled_by_default = false;
    bool skybox_uses_environment = false;
    float ground_size = 15.0f;
    float skybox_size = 20.0f;
    std::uint32_t skybox_width = 0;
    std::uint32_t skybox_mip_count = 0;
    std::uint32_t skybox_data_offset = 0;
    Vec3 ground_position{};
    Vec3 skybox_position{};
    // The pin's own environmentPrimaryColor default literals
    // (load-env.ts: 0.08697355964132344, ..., 0.2122208331110881), stored
    // at the float32 precision the shader uniforms carry.
    Color3 primary_color{0.08697356f, 0.08697356f, 0.21222083f};
};

struct Scene {
    Engine* engine = nullptr;
    /**
     * `enableMirroredMeshes` opted this scene into runtime winding
     * tracking. The pipeline-side half is installed process-wide upstream
     * and is compiled in here by the same feature, so what this flag
     * carries is only the per-scene watcher.
     */
    bool mirrored_meshes = false;
    Color4 clear_color{};
    CameraHandle camera{};
    std::vector<MeshHandle> meshes;
    std::vector<LightHandle> lights;
    std::vector<TaskHandle> tasks;
    std::vector<AnimationGroupHandle> animation_groups;
    std::vector<BillboardSystemHandle> billboard_systems;
    // `loadSplat` registers the renderable on the scene it is handed, the
    // way `attachGaussianSplattingMesh` pushes into `_renderables`.
    std::vector<SplatMeshHandle> splat_meshes;
    std::vector<std::function<void(float)>> before_render;
    std::vector<std::function<void(float)>> animation_seekers;
    /**
     * Whether this scene already contributed the seeker that reaches the
     * engine's animation managers. Registration is idempotent upstream,
     * so the contribution is too.
     */
    bool seeks_animation_managers = false;
    std::vector<std::function<void()>> deferred_builders;
    EnvironmentState environment;
    float fixed_delta_ms = 0.0f;
    std::uint64_t mesh_membership_version = 0;
    std::uint32_t material_family_mask = 0;
    bool transmission_enabled = false;
    float fog_mode = 0.0f;
    float fog_density = 0.0f;
    float fog_start = 0.0f;
    float fog_end = 0.0f;
    Color3 fog_color{};
};

/** A scene-less rendering context that owns only an ordered task graph. */
struct FrameGraphContext {
    Engine* engine = nullptr;
    std::vector<TaskHandle> tasks;
    std::vector<std::function<void(float)>> updates;
};

// No member defaults: generation fills every field from the pin's own
// factory defaults, so a second copy here could only drift. (The same
// holds for SphereOptions and TorusOptions below.)
struct GroundOptions {
    double width;
    double height;
    std::uint32_t subdivisions;
    Vec2 uv_scale;
};

struct BoxOptions {
    float width = 1.0f;
    float height = 1.0f;
    float depth = 1.0f;
};

struct PlaneOptions {
    float width = 1.0f;
    float height = 1.0f;
};

// The pin halves these as JavaScript numbers before its vertex chain rounds,
// so they are doubles here for the same reason `CameraRecord`'s scalars are.
struct SphereOptions {
    std::uint32_t segments;
    double diameter_x;
    double diameter_y;
    double diameter_z;
};

struct SphereMeshData {
    std::vector<float> positions;
    std::vector<float> normals;
    std::vector<float> uvs;
    std::vector<std::uint32_t> indices;
    std::uint32_t vertex_count = 0;
    std::uint32_t index_count = 0;
};

/**
 * One element of a list, grown to reach it.
 *
 * JavaScript extends an array when you assign past its end, and the pinned
 * ribbon relies on that: it fills `us[p]` for each path without sizing `us`
 * first. A C++ `operator[]` there is out of bounds, so an assignment
 * through this one grows instead -- which is the same array the pin ends
 * up with.
 */
template <typename T>
T& at_grow(std::vector<T>& values, std::size_t index) {
    if (values.size() <= index) {
        values.resize(index + 1);
    }
    return values[index];
}

/**
 * A scene's own row of `{x, y, z}` as the path a builder takes.
 *
 * The data model materializes an annotated `Vec3[]` a scene grew in a loop
 * as its own record type, and the pin's builder wants the record it
 * declares. Templated on the row rather than named per scene, because what
 * makes the two the same is that both spell the pin's three components.
 */
template <typename Points>
std::vector<Vec3d> vec3_path(const Points& points) {
    std::vector<Vec3d> path;
    path.reserve(points.size());
    for (const auto& point : points) {
        if constexpr (requires { point.x; point.y; point.z; }) {
            path.push_back(Vec3d{point.x, point.y, point.z});
        } else {
            path.push_back(Vec3d{point->x, point->y, point->z});
        }
    }
    return path;
}

/** The same, one level up: a scene's rows as a ribbon's path array. */
template <typename Rows>
std::vector<std::vector<Vec3d>> vec3_paths(const Rows& rows) {
    std::vector<std::vector<Vec3d>> paths;
    paths.reserve(rows.size());
    for (const auto& row : rows) {
        paths.push_back(vec3_path(row));
    }
    return paths;
}

/**
 * `RibbonOptions`, as the reached slice resolves it.
 *
 * The path array is the pin's own `Vec3[][]`, carried whole: a ribbon is
 * defined by its paths and there is nothing to resolve about them.
 */
struct RibbonOptions {
    std::vector<std::vector<Vec3d>> path_array;
    bool close_array;
    bool close_path;
};

/**
 * `PolyhedronOptions`, as the reached slice resolves it.
 *
 * The pin's `POLYHEDRA` table is data and the `type` a scene names is a
 * compile-time value, so generation picks the row and this carries that
 * row's own vertex and face lists. One polyhedron therefore costs one
 * table, not fifteen.
 */
struct PolyhedronOptions {
    double size_x;
    double size_y;
    double size_z;
    bool flat;
    std::vector<std::vector<double>> vertex;
    std::vector<std::vector<double>> face;
};

/**
 * `CylinderOptions`, as the reached slice resolves it.
 *
 * `diameter_top` and `diameter_bottom` are the pin's own `??` chain already
 * resolved, so the `diameter` shorthand does not survive here -- and the
 * shorthand is exactly why the zero question travels beside the value.
 */
struct CylinderOptions {
    double height;
    double diameter_top;
    double diameter_bottom;
    double tessellation;
    double subdivisions;
    /**
     * Whether the scene named a zero TOP diameter.
     *
     * The builder clamps a zero to 0.00001 for its ring maths, and asks
     * this separately to decide whether to reuse the previous ring's
     * normals at a cone tip. The pin asks it of the option the scene
     * wrote, so a zero arriving through the `diameter` shorthand answers
     * NO -- which is why the record carries the question and not just the
     * value.
     */
    bool diameter_top_is_zero;
};

/**
 * `DiscOptions`, as the reached slice resolves it.
 *
 * Every field is written by generation from the pinned factory's own `??`
 * chain, so none carries a default here.
 */
struct DiscOptions {
    double radius;
    double tessellation;
    double arc;
};

struct TorusOptions {
    double diameter;
    double thickness;
    std::uint32_t tessellation;
};

struct EnvironmentOptions {
    std::string environment_url;
    std::string ground_texture_url;
    std::string skybox_url;
    float skybox_size = 1000.0f;
    std::string brdf_url;
    // A skybox URL naming the .env itself asks for the environment's own
    // cubemap rather than a separate DDS, which is the pinned loader's
    // `skyboxIsEnv` branch. Decided at compile time from the two URLs.
    bool skybox_uses_environment = false;
    // The pinned `!bgOptions.skipSkybox` arm: no DDS, no .env skybox and no
    // `skipSkybox` leaves the solid-colour cube. Decided at compile time
    // alongside the flag above.
    bool solid_skybox = false;
    // The pinned `!bgOptions.skipGround` arm, which does not consult the
    // texture URL: `buildGroundRenderable` falls back to a 1x1 white texel.
    bool ground = false;
};

struct HdrEnvironmentOptions {
    std::string environment_url;
    std::string brdf_url;
    bool use_cubemap_skybox = false;
    float skybox_size = 0.0f;
    Vec3 skybox_position{};
};

// A prefiltered DDS cubemap arrives compiled into the same environment
// package an HDR source produces, so the loader needs only the two paths.
struct DdsEnvironmentOptions {
    std::string environment_url;
    std::string brdf_url;
};

// No defaulted option parameters below: generation always passes a full
// options literal, so an omitted-argument arm would be a dead second
// copy of the pin's defaults waiting for a caller to trust it.
Engine create_engine(EngineOptions options);
Scene create_scene_context(Engine& engine);
FrameGraphContext create_frame_graph_context(Engine& engine);
std::string asset_path(const std::string& relative_path);

MeshHandle create_box(Engine& engine, BoxOptions options);
MeshHandle create_ground(Engine& engine, GroundOptions options);
/**
 * The pinned heightmap ground: the grid above, displaced by an image.
 *
 * `height_map` names the packaged image beside the executable; the pin reads
 * it through a canvas, so what the displacement sees is RGBA8 either way.
 */
MeshHandle create_ground_from_height_map(
    Engine& engine,
    GroundOptions options,
    double min_height,
    double max_height,
    const char* height_map);
MeshHandle create_plane(Engine& engine, PlaneOptions options);
MeshHandle create_sphere(Engine& engine, SphereOptions options);
SphereMeshData create_sphere_data(SphereOptions options);
void attach_morph_target(
    Engine& engine,
    MeshHandle mesh,
    const std::vector<float>& positions,
    const std::vector<float>& normals,
    double vertex_count,
    float weight);
void set_morph_target_weights(
    Engine& engine,
    MeshHandle mesh,
    const std::vector<float>& weights);
MeshHandle create_torus(Engine& engine, TorusOptions options);
MeshHandle create_disc(Engine& engine, DiscOptions options);
MeshHandle create_cylinder(Engine& engine, CylinderOptions options);
MeshHandle create_polyhedron(Engine& engine, PolyhedronOptions options);
MeshHandle create_ribbon(Engine& engine, RibbonOptions options);
MeshHandle create_ribbon_mesh(
    Engine& engine,
    RibbonOptions options,
    std::string_view name);
MeshHandle create_extrude_shape(
    Engine& engine,
    const std::vector<Vec3d>& shape,
    const std::vector<Vec3d>& curve,
    double scale,
    double rotation);
MeshHandle create_tube(
    Engine& engine,
    const std::vector<Vec3d>& path_points,
    double radius,
    double tessellation_option);
MeshHandle create_mesh_from_data(
    Engine& engine,
    const std::string& name,
    const std::vector<float>& positions,
    const std::vector<float>& normals,
    const std::vector<std::uint32_t>& indices,
    const std::vector<float>& uvs,
    const std::vector<float>& uvs2,
    const std::vector<float>& tangents,
    const std::vector<float>& colors);
// The matrices parameter is a non-const lvalue reference on purpose: the
// record keeps aliasing the caller's array for later per-frame updates
// (the pinned setThinInstances adopts the array by reference), so a
// temporary here would dangle. The compiler only passes named bindings.
void set_thin_instances(
    Engine& engine,
    MeshHandle mesh,
    std::vector<float>& matrices,
    double count);
void set_thin_instance_count(
    Engine& engine,
    MeshHandle mesh,
    double count);
void flush_thin_instances(Engine& engine, MeshHandle mesh);
void upload_thin_instance_matrices(
    Engine& engine,
    MeshHandle mesh,
    const std::vector<float>& matrices,
    double count);
void set_thin_instance_colors(
    Engine& engine,
    MeshHandle mesh,
    const std::vector<float>& colors);
void flatten_line_attributes(
    const std::vector<std::vector<Vec3>>& lines,
    const std::vector<std::vector<Vec4>>& colors,
    std::size_t vertex_count,
    std::vector<float>& positions,
    std::vector<float>& out_colors,
    std::vector<std::uint32_t>* line_point_counts,
    std::vector<std::uint32_t>* indices);
LineSystemData create_line_system_data(
    const std::vector<std::vector<Vec3>>& lines,
    const std::vector<std::vector<Vec4>>& colors);
MeshHandle create_line_system(
    Engine& engine,
    const std::string& name,
    const std::vector<std::vector<Vec3>>& lines,
    const std::vector<std::vector<Vec4>>& colors,
    MaterialHandle material);
void update_line_system(
    Engine& engine,
    MeshHandle mesh,
    const std::vector<std::vector<Vec3>>& lines,
    const std::vector<std::vector<Vec4>>& colors);
AssetHandle load_gltf(Engine& engine, const std::string& path);
// The opt-in bone-control surface (`src/skeleton/bone-control.ts`), defined
// by a generated glTF loader compiled with it. `getBoneByName` answers from
// the skeleton's own name map -- the first joint carrying the name, in joint
// order -- and reports a miss as an invalid handle, which is the `undefined`
// the pin returns. `setBoneVisible` writes the asset-wide override and
// re-bakes, so it works with no animation at all.
BoneHandle get_bone_by_name(
    Engine& engine,
    SkeletonHandle skeleton,
    const std::string& name);
void set_bone_visible(
    Engine& engine,
    SkeletonHandle skeleton,
    BoneHandle bone,
    bool visible);
AssetHandle load_babylon(Engine& engine, const std::string& path);
void load_environment(Scene& scene, EnvironmentOptions options);
void load_hdr_environment(Scene& scene, HdrEnvironmentOptions options);
void load_dds_environment(Scene& scene, DdsEnvironmentOptions options);
MaterialHandle create_standard_material(Engine& engine);
MaterialHandle create_grid_material(
    Engine& engine,
    GridMaterialOptions options);
MaterialHandle create_shader_material(
    Engine& engine,
    std::uint32_t variant);
/**
 * One texture a scene handed `parseNodeMaterialFromSnippet` through its
 * `textures` record, under the binding name it keyed it by.
 *
 * The name travels rather than a slot index because the pin's own join is by
 * name (`options.textures?.[tb._name]`), and which pair a name landed on is
 * the composed graph's answer -- `create_node_material` resolves the two
 * against each other exactly where upstream does.
 */
struct NodeMaterialTexture {
    std::string name;
    FileTexture texture;
};

MaterialHandle create_node_material(
    Engine& engine,
    std::uint32_t variant,
    std::vector<NodeMaterialTexture> textures);
void set_shader_uniform_values(
    Engine& engine,
    MaterialHandle material,
    std::uint32_t offset,
    std::uint32_t count,
    const float* values);
void set_shader_uniform_value(
    Engine& engine,
    MaterialHandle material,
    std::uint32_t offset,
    float v0);
void set_shader_uniform_value(
    Engine& engine,
    MaterialHandle material,
    std::uint32_t offset,
    float v0,
    float v1);
void set_shader_uniform_value(
    Engine& engine,
    MaterialHandle material,
    std::uint32_t offset,
    float v0,
    float v1,
    float v2);
void set_shader_uniform_value(
    Engine& engine,
    MaterialHandle material,
    std::uint32_t offset,
    float v0,
    float v1,
    float v2,
    float v3);
void set_shader_texture(
    Engine& engine,
    MaterialHandle material,
    std::uint32_t slot,
    FileTexture texture);
void set_shader_pixels_texture(
    Engine& engine,
    MaterialHandle material,
    std::uint32_t slot,
    const PixelsTexture& texture);
void set_standard_diffuse_render_texture(
    Engine& engine,
    MaterialHandle material,
    RenderTextureRef texture);
void set_alpha_to_coverage(
    Engine& engine,
    MaterialHandle material,
    bool enabled);
void set_pbr_unlit(Engine& engine, MaterialHandle material);
void set_pbr_skybox(Engine& engine, MaterialHandle material);
void set_pbr_clearcoat(
    Engine& engine,
    MaterialHandle material,
    bool enabled,
    float intensity,
    float roughness,
    float index_of_refraction,
    float normal_scale);
void set_pbr_anisotropy(
    Engine& engine,
    MaterialHandle material,
    bool enabled,
    float intensity,
    Vec2 direction);
void set_pbr_iridescence(
    Engine& engine,
    MaterialHandle material,
    bool enabled,
    float intensity,
    float index_of_refraction,
    float minimum_thickness,
    float maximum_thickness);
void set_pbr_sheen(
    Engine& engine,
    MaterialHandle material,
    bool enabled,
    Color3 color,
    float roughness,
    float intensity);
void set_pbr_sheen_texture(
    Engine& engine,
    MaterialHandle material,
    FileTexture texture);
void set_pbr_emissive(
    Engine& engine,
    MaterialHandle material,
    Color3 color);
void set_pbr_metallic_reflectance(
    Engine& engine,
    MaterialHandle material,
    bool has_color,
    Color3 color,
    FileTexture metallic_texture,
    FileTexture reflectance_texture);
void set_pbr_subsurface(
    Engine& engine,
    MaterialHandle material,
    float intensity,
    Color3 color,
    Color3 diffusion_distance,
    float minimum_thickness,
    float maximum_thickness,
    FileTexture thickness_texture);
SolidTexture create_solid_texture(Engine& engine, float r, float g, float b, float a = 1.0f);
FileTexture load_file_texture(
    Engine& engine,
    const std::string& path,
    TextureSamplerState sampler,
    bool invert_y,
    bool srgb,
    bool premultiply_alpha = false);
// `ktx-loader.ts` loadKtxTexture2D, past the suffix selection generation
// resolved: the container is parsed and its blocks are uploaded as they
// are. `invert_y` is the texture-object property the pin's own loader
// leaves unset here and sets in `basis-loader.ts`, which is what decides
// the Standard UV block's V flip.
FileTexture load_compressed_texture(
    Engine& engine,
    const std::string& path,
    bool invert_y);
void set_material_base_color_file(
    Engine& engine,
    MaterialHandle material,
    FileTexture texture);
MaterialHandle create_pbr_material(
    Engine& engine,
    PbrMaterialOptions options);
MaterialHandle create_standard_no_color_material_view(
    Engine& engine,
    MaterialHandle source);
MaterialHandle create_standard_esm_shadow_material_view(
    Engine& engine,
    MaterialHandle source,
    ShadowGeneratorHandle generator);
MaterialHandle create_pbr_esm_shadow_material_view(
    Engine& engine,
    MaterialHandle source,
    ShadowGeneratorHandle generator);
MaterialHandle create_node_esm_shadow_material_view(
    Engine& engine,
    MaterialHandle source,
    ShadowGeneratorHandle generator);
MaterialHandle create_pbr_no_color_material_view(
    Engine& engine,
    MaterialHandle source);
void mark_material_ubo_dirty(Engine& engine, MaterialHandle material);
void set_standard_emissive_texture(
    Engine& engine,
    MaterialHandle material,
    RenderTextureRef texture);
void set_standard_emissive_file_texture(
    Engine& engine,
    MaterialHandle material,
    const FileTexture& texture);
void set_standard_diffuse_pixels_texture(
    Engine& engine,
    MaterialHandle material,
    const PixelsTexture& texture);
void set_standard_diffuse_file_texture(
    Engine& engine,
    MaterialHandle material,
    const FileTexture& texture);
void enable_material_uv_transform(
    Engine& engine,
    MaterialHandle material);
void set_material_plugins(
    Engine& engine,
    MaterialHandle material,
    std::uint8_t signature_index);
LightHandle create_hemispheric_light(Engine& engine, Vec3 direction, float intensity = 1.0f);
LightHandle create_directional_light(Engine& engine, Vec3 direction, float intensity = 1.0f);
LightHandle create_point_light(Engine& engine, Vec3 position, float intensity = 1.0f);
LightHandle create_spot_light(
    Engine& engine,
    Vec3 position,
    Vec3 direction,
    double angle,
    float exponent,
    float intensity = 1.0f);
// A light's position and direction are ObservableVec3 upstream: writing one
// marks the light's local matrix dirty, and the next read rebuilds it. These
// entry points are that pair — the field write plus the rebuild — and each is
// emitted beside its own kind's factory, so a scene reaching no light of a
// kind links none of them. Only the vectors a reached scene writes are
// lowered; the rest refuse at compile time (src/compiler/assignments.ts).
void set_point_light_position(Engine& engine, LightHandle light, Vec3 position);
void set_directional_light_position(Engine& engine, LightHandle light, Vec3 position);
// src/scene/transform-node.ts createTransformNode: a SceneNode with the
// pinned factory's own TRS defaults. Its setters take the same shape the
// light vector setters take -- the field write plus the version bump a
// child re-bakes against -- because upstream both are ObservableVec3 writes
// on a node whose world matrix is lazily recomposed.
TransformNodeHandle create_transform_node(
    Engine& engine,
    std::string name,
    Vec3d position,
    Vec4 rotation_quaternion,
    Vec3 scaling);
void set_transform_node_position(
    Engine& engine,
    TransformNodeHandle node,
    Vec3d position);
void set_transform_node_scaling(
    Engine& engine,
    TransformNodeHandle node,
    Vec3 scaling);
void set_transform_node_rotation_quaternion(
    Engine& engine,
    TransformNodeHandle node,
    Vec4 rotation);
// `child.parent = node` drives the transform math; `node.children.push`
// only fills the traversal list. Upstream keeps them apart in exactly this
// way, so each is its own entry point.
// src/mesh/enable-mirrored-meshes.ts: the opt-in that installs winding
// reversal from the live world determinant, for the meshes the glTF
// loader's own load-time pass cannot see.
void enable_mirrored_meshes(Scene& scene);
// A bounded multi-frame drain: the scene's own condition, which the frame
// loops consult before they capture. Upstream the wait sits in front of
// `canvas.dataset.ready`, and the harness screenshots on that flag -- so a
// capture taken before the condition holds is a different frame.
void defer_capture_until(Engine& engine, std::function<bool()> ready);
void set_mesh_transform_parent(
    Engine& engine,
    MeshHandle mesh,
    TransformNodeHandle parent);
void push_transform_node_child(
    Engine& engine,
    TransformNodeHandle node,
    MeshHandle child);
void set_spot_light_position(Engine& engine, LightHandle light, Vec3 position);
void set_spot_light_direction(Engine& engine, LightHandle light, Vec3 direction);
// The spot cone angle is an accessor upstream rather than a field: its setter
// recomputes the cone cosine `_writeLightUbo` packs. The record holds both, so
// this entry point writes the pair from the pin's own half-angle expression.
void set_spot_light_angle(Engine& engine, LightHandle light, double angle);
CameraHandle create_arc_rotate_camera(Engine& engine, double alpha, double beta, double radius, Vec3d target);
CameraHandle create_free_camera(Engine& engine, Vec3d position, Vec3d target);
CameraHandle create_default_camera(Engine& engine, Scene& scene);
// Returns the same camera so the caller can keep using it as the live
// orthographic bounds object the pinned entry point hands back.
CameraHandle enable_orthographic_camera(
    Engine& engine,
    CameraHandle camera,
    double half_height);

RenderTargetHandle create_render_target(
    Engine& engine,
    RenderTargetOptions options);
RenderTargetTexture create_render_target_texture(
    Engine& engine,
    RenderTargetOptions options);
RenderTargetHandle swapchain_render_target(Engine& engine);
TaskHandle create_render_task(
    Engine& engine,
    Scene& scene,
    RenderTaskOptions options);
TaskHandle create_geometry_renderer_task(
    Engine& engine,
    Scene& scene,
    GeometryTaskOptions options);
TaskHandle create_copy_to_texture_task(
    Engine& engine,
    Scene& scene,
    CopyTaskOptions options);
TaskHandle create_post_process_task(
    Engine& engine,
    PostProcessTaskOptions options);
void update_post_process_uniforms(Engine& engine, TaskHandle task);
RenderTextureRef render_target_texture(RenderTargetHandle target);
RenderTextureRef geometry_task_texture(
    TaskHandle task,
    GeometryTextureType type);
RenderTextureRef geometry_task_output_texture(TaskHandle task);
RenderTextureRef geometry_task_depth_texture(TaskHandle task);
void add_task(Scene& scene, TaskHandle task);
void add_task_at_start(Scene& scene, TaskHandle task);
void add_task(FrameGraphContext& context, TaskHandle task);
void add_task_at_start(FrameGraphContext& context, TaskHandle task);

/**
 * `PcfSpotlightShadowGeneratorConfig`, as the reached slice resolves it.
 *
 * `mapSize` sizes a GPU texture, so it is decided at generation; the rest
 * are the pinned `??` defaults or what the scene passed, at the JavaScript
 * width the pin holds them (a spot's projection near/far reach the
 * perspective volume before any float store).
 */
struct PcfSpotShadowOptions {
    std::uint32_t map_size = 512;
    double bias = 0.0;
    double darkness = 0.0;
    double near_plane = 1.0;
    double far_plane = 10000.0;
};

/**
 * `createEsmDirectionalShadowGenerator`'s options, in its own order.
 *
 * `blur_kernel` is here for the record rather than for a run-time read: the
 * blur fragment's tap table is folded from it at generation, so a value that
 * disagreed with the deployed shader would be a silent fork.
 */
struct EsmDirectionalShadowOptions {
    std::uint32_t map_size = 1024;
    double depth_scale = 50.0;
    double bias = 0.00005;
    std::uint32_t blur_kernel = 1;
    std::uint32_t blur_scale = 2;
    double darkness = 0.0;
    double frustum_edge_falloff = 0.0;
    double ortho_min_z = 1.0;
    double ortho_max_z = 10000.0;
    /**
     * Which row of the generated resource table is this generator's.
     * Generation composed one row per ESM factory call, in reach order, so
     * the ordinal is a compile-time value like the three above it.
     */
    std::uint32_t esm_index = 0;
};

/**
 * `PcfDirectionalShadowGeneratorConfig`, as the reached slice resolves it.
 *
 * The spot generator's own three, plus the ortho volume the caster fit
 * projects into — a directional light has no position to project from, so
 * `near`/`far` are replaced by the pair `computeDirectionalLightMatrix`
 * takes. `normalBias` and `forceRefreshEveryFrame` are unreached and refuse
 * by name, exactly as they do on the other two factories.
 */
struct PcfDirectionalShadowOptions {
    // No initialisers: generation writes every field from the factory's own
    // `??` chain, so a default written here would be a second copy of a
    // pinned constant that nothing can catch drifting. A field the emitter
    // forgets is then a compile error rather than a silent 1024.
    std::uint32_t map_size;
    double bias;
    double darkness;
    double ortho_min_z;
    double ortho_max_z;
};

ShadowGeneratorHandle create_pcf_spotlight_shadow_generator(
    Engine& engine,
    LightHandle light,
    PcfSpotShadowOptions options);
ShadowGeneratorHandle create_esm_directional_shadow_generator(
    Engine& engine,
    LightHandle light,
    EsmDirectionalShadowOptions options);
ShadowGeneratorHandle create_pcf_directional_shadow_generator(
    Engine& engine,
    LightHandle light,
    PcfDirectionalShadowOptions options);
void set_shadow_task_caster_meshes(
    Engine& engine,
    ShadowGeneratorHandle generator,
    std::vector<MeshHandle> caster_meshes);
void add_render_task_mesh(
    Engine& engine,
    TaskHandle task,
    MeshHandle mesh,
    MaterialHandle material);

void add_to_scene(Scene& scene, MeshHandle mesh);
void add_to_scene(Scene& scene, LightHandle light);
void add_to_scene(Scene& scene, AssetHandle asset);
void add_asset_entities(Scene& scene, AssetHandle asset);
AssetHandle clone_asset_root(Engine& engine, AssetHandle asset);
void set_asset_root_position_component(
    Engine& engine,
    AssetHandle asset,
    std::size_t component,
    float value);
void remove_from_scene(Scene& scene, MeshHandle mesh);
void on_before_render(
    Scene& scene,
    std::function<void(float)> callback);
void on_key_down(
    Engine& engine,
    std::function<void(const PlatformKeyboardEvent&)> callback);
void on_key_up(
    Engine& engine,
    std::function<void(const PlatformKeyboardEvent&)> callback);
void on_pointer_down(
    Engine& engine,
    std::function<void()> callback);
void on_mouse_down(
    Engine& engine,
    std::function<void(const PlatformMouseEvent&)> callback);
void on_mouse_up(
    Engine& engine,
    std::function<void(const PlatformMouseEvent&)> callback);
void on_visibility_change(
    Engine& engine,
    std::function<void(bool)> callback);
PropertyAnimationManager create_animation_manager();
PropertyAnimationClip create_property_animation_clip(
    std::string name,
    std::vector<PropertyAnimationTrack> tracks,
    float frame_rate);
PropertyAnimationGroup create_property_animation_group(
    PropertyAnimationManager manager,
    PropertyAnimationTarget target,
    PropertyAnimationClip clip,
    PropertyAnimationGroupOptions options);
void set_animation_weight(
    PropertyAnimationGroup group,
    float weight);
void set_animation_weight(
    Engine& engine,
    AnimationGroupHandle group,
    float weight);
void enable_animation_blending(
    PropertyAnimationManager manager);
void enable_property_animation_blending(
    PropertyAnimationManager manager);
void start_animation_manager(
    PropertyAnimationManager manager,
    Scene& scene);
PropertyAnimationManager create_animation_manager(
    Engine& engine);
void add_animation_groups(
    PropertyAnimationManager manager,
    Engine& engine,
    const std::vector<AnimationGroupHandle>& groups);
void update_animation_manager(
    PropertyAnimationManager manager,
    Engine& engine,
    float delta_ms);
void seek_animation_manager(
    PropertyAnimationManager manager,
    Engine& engine,
    float time);
void go_to_frame(
    PropertyAnimationGroup group,
    Engine& engine,
    float frame);
void go_to_frame(
    Engine& engine,
    AnimationGroupHandle group,
    float frame,
    bool with_engine);
void play_animation(Engine& engine, AnimationGroupHandle group);
void pause_animation(Engine& engine, AnimationGroupHandle group);
void stop_animation(Engine& engine, AnimationGroupHandle group);
void set_animation_loop(
    Engine& engine,
    AnimationGroupHandle group,
    bool loop);
void set_animation_speed_ratio(
    Engine& engine,
    AnimationGroupHandle group,
    float speed_ratio);
void set_animation_mask(
    Engine& engine,
    AnimationGroupHandle group,
    const std::vector<std::string>& names,
    bool include);
void set_animation_current_time(
    Engine& engine,
    AnimationGroupHandle group,
    float time);
void set_animation_additive(
    Engine& engine,
    AnimationGroupHandle group,
    float reference_time);
void set_animation_additive_from_frame(
    Engine& engine,
    AnimationGroupHandle group,
    float reference_frame);
void attach_control(Engine& engine, CameraHandle camera);
void set_camera_limits(
    Engine& engine,
    CameraHandle camera,
    std::uint32_t present_mask,
    const std::array<double, 6>& limits);
void attach_free_control(Engine& engine, CameraHandle camera);
struct LoadSpriteAtlasOptions {
    float grid_width_px = 0.0f;
    float grid_height_px = 0.0f;
    TextureFilter sampling = TextureFilter::linear;
    bool premultiplied_alpha = false;
    bool premultiply_on_load = false;
    // `...options.textureOptions` spreads over the atlas defaults, so a
    // caller's address mode replaces the clamp the loader stamps. A tiling
    // scroll wants repeat on both axes.
    TextureAddressMode address_u = TextureAddressMode::clamp;
    TextureAddressMode address_v = TextureAddressMode::clamp;
};

struct GridSpriteAtlasOptions {
    double cell_width_px = 0.0;
    double cell_height_px = 0.0;
    bool has_columns = false;
    double columns = 0.0;
    bool has_rows = false;
    double rows = 0.0;
    double margin_px = 0.0;
    double spacing_px = 0.0;
    Vec2 pivot{0.5f, 0.5f};
    bool premultiplied_alpha = false;
};

/** Normalized runtime input to the in-memory sprite-atlas shelf packer. */
struct SpriteAtlasFramePixelsView {
    const std::uint8_t* pixels = nullptr;
    std::size_t byte_length = 0;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    std::uint32_t src_x = 0;
    std::uint32_t src_y = 0;
    std::uint32_t src_stride_bytes = 0;
    Vec2 pivot{0.5f, 0.5f};
};

struct SpriteAtlasPackOptions {
    std::uint32_t padding_px = 1;
    std::uint32_t max_width_px = 1024;
    TextureFilter sampling = TextureFilter::nearest;
    bool premultiplied_alpha = false;
    bool has_capacity = false;
    std::uint32_t capacity_width = 0;
    std::uint32_t capacity_height = 0;
};

struct Sprite2DLayerOptions {
    float capacity = 16.0f;
    SpriteBlendDescriptor blend_mode{};
    float opacity = 1.0f;
    bool visible = true;
    float order = 0.0f;
    Vec2 pivot{0.5f, 0.5f};
    std::uint32_t custom_shader = 0;
    std::vector<PixelsTexture> custom_textures;
};

/**
 * Per-sprite init record (`Sprite2DProps`). Every optional field carries a
 * `has_` companion because the pinned writer distinguishes "absent" from a
 * value: an absent `sizePx` falls back to the frame, an absent `flipX`
 * preserves the orientation already baked into the UVs.
 */
/**
 * createFacingBillboardSystem's options. Every generated construction is a
 * full designated-initializer literal (the pin's defaults are emitted by
 * generation and anchored against the pinned defaults table), so the
 * members carry no initializers of their own — a partially-built options
 * struct would be a generation bug, not a fallback.
 */
struct BillboardSystemOptions {
    double capacity;
    SpriteBlendDescriptor blend;
    float opacity;
    bool visible;
    float alpha_cutoff;
    bool has_alpha_cutoff;
    std::uint32_t custom_shader;
    std::vector<PixelsTexture> custom_textures;
    // particle-billboard-renderable.ts: the mode-4 wrapper's SECOND pass.
    // The pin builds it as `{...system, blendMode: createParticleBlend(2),
    // _customShader: undefined}` when the renderable is built; here the
    // generated builder fills it by name, so no backend resolves a blend of
    // its own. Read only when `blend.particle_passes == 2`.
    SpriteBlendDescriptor add_pass_blend{};
};

/** addBillboardSpriteIndex's props; a `has_` flag marks what was named. */
struct BillboardSpriteProps {
    Vec3 position{};
    Vec2 size_world{};
    bool has_size_world = false;
    float frame = 0.0f;
    bool has_frame = false;
    float rotation = 0.0f;
    bool has_rotation = false;
    Vec2 pivot{};
    bool has_pivot = false;
    Vec4 color{1.0f, 1.0f, 1.0f, 1.0f};
    bool has_color = false;
    bool flip_x = false;
    bool has_flip_x = false;
    bool flip_y = false;
    bool has_flip_y = false;
    bool visible = true;
    bool has_visible = false;
};

struct Sprite2DProps {
    Vec2 position_px{};
    // `addSprite2DIndex` throws without `positionPx`; `updateSprite2DIndex`
    // takes a `Partial<Sprite2DProps>`, where an omitted position preserves
    // the slot's own. Both arms write this explicitly.
    bool has_position_px = false;
    Vec2 size_px{};
    bool has_size_px = false;
    float frame = 0.0f;
    bool has_frame = false;
    float rotation = 0.0f;
    bool has_rotation = false;
    Vec4 color{1.0f, 1.0f, 1.0f, 1.0f};
    bool has_color = false;
    bool flip_x = false;
    bool has_flip_x = false;
    bool flip_y = false;
    bool has_flip_y = false;
    bool visible = true;
    bool has_visible = false;
};

struct SpriteRendererOptions {
    std::vector<Sprite2DLayerHandle> layers;
    bool clear = true;
    Color4 clear_value{0.0f, 0.0f, 0.0f, 1.0f};
};

SplatMeshHandle load_splat(Scene& scene, const std::string& path);
// Bakes a cloud's own world matrix into its rows, rebuilds its geometry and
// resets its TRS. Defined by the generated splat bake, which a scene reaches
// through `bakeCurrentTransformIntoVertices`.
void bake_current_transform_into_vertices(
    Engine& engine,
    SplatMeshHandle splat);
SpriteAtlasHandle load_sprite_atlas(
    Engine& engine,
    const std::string& path,
    LoadSpriteAtlasOptions options);
SpriteAtlasHandle create_grid_sprite_atlas(
    Engine& engine,
    const FileTexture& texture,
    GridSpriteAtlasOptions options);
SpriteAtlasHandle create_grid_sprite_atlas(
    Engine& engine,
    SpriteRenderTextureHandle texture,
    GridSpriteAtlasOptions options);
SpriteRenderTextureHandle create_sprite_render_texture(
    Engine& engine,
    double width,
    double height);
void set_sprite_renderer_target(
    Engine& engine,
    SpriteRendererHandle renderer,
    SpriteRenderTextureHandle target,
    bool has_target);
SpriteAtlasHandle create_sprite_atlas_from_frames(
    Engine& engine,
    const std::vector<SpriteAtlasFramePixelsView>& sources,
    SpriteAtlasPackOptions options);
Sprite2DLayerHandle create_sprite_2d_layer(
    Engine& engine,
    SpriteAtlasHandle atlas,
    Sprite2DLayerOptions options);
BillboardSystemHandle create_billboard_system(
    Engine& engine,
    SpriteAtlasHandle atlas,
    BillboardOrientation orientation,
    Vec3 axis,
    BillboardSystemOptions options);

double add_billboard_sprite_index(
    Engine& engine,
    BillboardSystemHandle system,
    BillboardSpriteProps props);

void clear_billboard_sprites(
    Engine& engine,
    BillboardSystemHandle system);

void add_billboard_system(
    Scene& scene,
    BillboardSystemHandle system);

void set_billboard_alpha_to_coverage(
    Engine& engine,
    BillboardSystemHandle system,
    bool enabled);

void set_sprite_2d_uv_offset(
    Engine& engine,
    Sprite2DLayerHandle layer,
    double index,
    Vec2 uv_offset);

void set_sprite_2d_shader_params(
    Engine& engine,
    Sprite2DLayerHandle layer,
    Vec4 params);

void set_billboard_shader_params(
    Engine& engine,
    BillboardSystemHandle system,
    Vec4 params);

/**
 * The sampler overrides `createTexture2DFromPixels` accepts.
 *
 * Each field carries a "was it named" flag rather than a default, because
 * upstream resolves `options.x ?? default` inside the factory itself — so
 * the defaults live in the generated factory, read off the pin's own
 * expression, and nothing here restates one. `srgb` is the fifth option and
 * is refused at generation: no reached call passes it.
 */
struct PixelsTextureOptions {
    TextureFilter min_filter{};
    bool has_min_filter = false;
    TextureFilter mag_filter{};
    bool has_mag_filter = false;
    TextureAddressMode address_u{};
    bool has_address_u = false;
    TextureAddressMode address_v{};
    bool has_address_v = false;
};

PixelsTexture create_texture_2d_from_pixels(
    Engine& engine,
    const std::string& path,
    double width,
    double height,
    PixelsTextureOptions options = {});
PixelsTexture create_texture_2d_from_pixels(
    Engine& engine,
    const js::U8Array& pixels,
    double width,
    double height,
    PixelsTextureOptions options = {});

double add_sprite_2d_index(
    Engine& engine,
    Sprite2DLayerHandle layer,
    Sprite2DProps props);
void update_sprite_2d_index(
    Engine& engine,
    Sprite2DLayerHandle layer,
    double index,
    Sprite2DProps props);
void clear_sprite_2d_layer(
    Engine& engine,
    Sprite2DLayerHandle layer);
EffectWrapperHandle create_effect_wrapper(
    Engine& engine,
    std::uint32_t variant);
void set_effect_uniforms(
    Engine& engine,
    EffectWrapperHandle effect,
    const std::vector<float>& values);
void set_effect_texture(
    Engine& engine,
    EffectWrapperHandle effect,
    const std::string& name,
    SolidTexture texture);
EffectRendererHandle create_effect_renderer(
    Engine& engine,
    EffectWrapperHandle effect,
    EffectRendererOptions options);
void register_effect_renderer(
    Engine& engine,
    EffectRendererHandle renderer);
TaskHandle create_effect_render_task(
    Engine& engine,
    EffectTaskOptions options);
SpriteRendererHandle create_sprite_renderer(
    Engine& engine,
    SpriteRendererOptions options);
void add_sprite_renderer_layer(
    Engine& engine,
    SpriteRendererHandle renderer,
    Sprite2DLayerHandle layer);
bool remove_sprite_renderer_layer(
    Engine& engine,
    SpriteRendererHandle renderer,
    Sprite2DLayerHandle layer);
void dispose_sprite_renderer(
    Engine& engine,
    SpriteRendererHandle renderer);
void unregister_sprite_renderer(
    Engine& engine,
    SpriteRendererHandle renderer);
void register_sprite_renderer(
    Engine& engine,
    SpriteRendererHandle renderer);

void register_scene(Scene& scene);
void on_frame_graph_update(
    FrameGraphContext& context,
    std::function<void(float)> callback);
void register_frame_graph_context(FrameGraphContext& context);
/**
 * `registerSceneWithShadowSupport`: the ordinary registration plus the
 * scene-owned shadow task, which the pin installs ahead of the render task
 * the scene already carries. Upstream keeps the two entry points apart so an
 * ordinary bundle retains no shadow scheduling code at all.
 */
void register_scene_with_shadow_support(Scene& scene);
void enable_scene_transmission(Scene& scene);
void load_image_skybox(
    Scene& scene,
    std::array<std::string, 6> face_paths,
    float size);
void set_scene_fog(
    Scene& scene,
    float mode,
    float density,
    float start,
    float end,
    Color3 color);
void start_engine(Engine& engine);
/** `stopEngine`: no further frame submits. */
void stop_engine(Engine& engine);
/** `setTimeout(callback, 0)`; see `Engine::deferred_callbacks`. */
void defer_callback(Engine& engine, std::function<void()> callback);
/** Browser `setInterval`; callbacks are serviced by the frame conductor. */
double set_interval(
    Engine& engine,
    std::function<void()> callback,
    double period_ms);
/** Browser `clearInterval`. */
void clear_interval(Engine& engine, double id);

/** src/scene/set-parent.ts setParent for the reached mesh hierarchy. */
void set_mesh_parent(
    Engine& engine,
    MeshHandle child,
    MeshHandle parent);
[[nodiscard]] std::vector<float> mesh_cpu_positions(
    const Engine& engine,
    MeshHandle mesh);
[[nodiscard]] std::vector<float> mesh_cpu_normals(
    const Engine& engine,
    MeshHandle mesh);
[[nodiscard]] std::vector<float> mesh_cpu_uvs(
    const Engine& engine,
    MeshHandle mesh);
[[nodiscard]] std::vector<std::uint32_t> mesh_cpu_indices(
    const Engine& engine,
    MeshHandle mesh);
[[nodiscard]] js::Array<double> mesh_world_matrix_array(
    const Engine& engine,
    MeshHandle mesh);
[[nodiscard]] js::Array<double> mesh_bound_min_array(
    const Engine& engine,
    MeshHandle mesh);
[[nodiscard]] js::Array<double> mesh_bound_max_array(
    const Engine& engine,
    MeshHandle mesh);

/** `createGpuPicker(scene)`. */
GpuPickerHandle create_gpu_picker(Scene& scene);
/** `PickingInfo.pickedMesh.name`, read where the scene asks for it. */
[[nodiscard]] std::string picked_node_name(
    const Engine& engine,
    const PickingInfo& info);
/** A picked scene node asserted to the pinned `Mesh` type. */
[[nodiscard]] MeshHandle picked_mesh(const PickingInfo& info);
/** The basic pick's nullable world point in the plain-data model. */
[[nodiscard]] js::Nullable<std::array<double, 3>> picked_point(
    const PickingInfo& info);
/** Populate basic picking's world-space `pickedPoint` from its depth lane. */
void populate_picked_point(
    PickingInfo& info,
    const std::array<float, 16>& view_projection,
    double sample_x,
    double sample_y,
    double width,
    double height,
    float depth);
/** `pickAsync(picker, x, y)`, resolved before the call returns. */
PickingInfo gpu_pick(
    Engine& engine,
    GpuPickerHandle picker,
    double x,
    double y);
/** `disposePicker(picker)`. */
void dispose_picker(Engine& engine, GpuPickerHandle picker);
/**
 * Run and clear everything `setTimeout` queued. Called by the frame
 * conductor after the frame's own callbacks, which is where the browser
 * runs a zero-delay timeout: after the current turn, before the next
 * frame. A callback that queues another is served on the following
 * frame rather than in this drain, exactly as it would be in a browser.
 */
void run_deferred_callbacks(Engine& engine);
/** Run recurring callbacks due at this frame boundary. */
void run_interval_callbacks(Engine& engine);

} // namespace bbl
