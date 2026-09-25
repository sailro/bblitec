// GPU picking's backend-independent half: the pick blocks, the candidate
// walks, the readback layout and the request and result tails.
#pragma once
#include <bblite/features/has_billboards.hpp>
#include <bblite/features/has_detailed_picking.hpp>
#include <bblite/features/has_pbr_renderer.hpp>
#include <bblite/features/has_picking.hpp>
#include <bblite/features/has_splats.hpp>
#include <bblite/features/has_sprites.hpp>
#include "pal_gpu_scene_blocks.hpp"

namespace bbl::pal {

#if BBLITE_HAS_PICKING
// GPU picking's backend-independent half. The arithmetic -- the pointer
// mapping, the two shears, the id encoding and decoding -- is lowered from
// `picking/gpu-picker.ts`, `picking/gs-picking-pipeline.ts` and the
// splat picking fragment into `upstream/picking_math.hpp`; the records and
// the orchestration both backends share are here.

/** The pin's `SceneUniforms`: the sheared VP, then the sampled pixel. */
struct PickSceneUniforms {
    std::array<float, 16> view_projection{};
    std::array<float, 2> fragment_coord{};
    std::array<float, 2> _pad{};
};

/** The pin's `MeshUniforms`: the world matrix, then the id. */
struct PickMeshUniforms {
    std::array<float, 16> world{};
    std::uint32_t pick_id = 0;
    std::uint32_t excluded_thin_instance_start = 0;
    std::uint32_t excluded_thin_instance_count = 0;
    std::uint32_t _pad = 0;
};

#if BBLITE_HAS_SPLATS
using upstream::compute_cloud_pick_matrix;
#endif

/**
 * One candidate the pick pass drew, in submission order.
 *
 * Upstream keeps mesh ranges and contributor ranges apart because a thin
 * instance makes a mesh's range wider than one id; nothing in the reached
 * slice does, so one id is one node and the two lists are one -- except
 * for a billboard system, which is the shape the pin's contributor seam
 * was drawn for: one entity owns `system.count` consecutive ids, and
 * `pick_id - id` is the sprite's own slot.
 */
struct PickRange {
    std::uint32_t id = 0;
    PickedNodeKind kind = PickedNodeKind::none;
    std::uint32_t index = invalid_handle;
    std::uint32_t count = 1;
    /** A mesh candidate's handle generation (`MeshHandle::generation`). */
    std::uint32_t generation = 0;
};

/**
 * The id the one-pixel target held, resolved against what was drawn.
 *
 * Zero is the cleared attachment, which is upstream's "nothing here"; an
 * id no range claims cannot happen while the draw loop and the range list
 * agree, and saying so is cheaper than debugging a silent miss if they
 * ever stop agreeing.
 */
PickingInfo resolve_pick_result(const std::vector<PickRange>& ranges, std::uint32_t pick_id);

/**
 * The pin's `BB` block for one billboard system's pick draw, 48 bytes.
 *
 * `packBillboardPickUbo` writes the camera basis the pick vertex stage
 * expands its quad around. It cannot read that basis from the pick scene
 * block -- that carries only the sheared view projection -- so upstream
 * lifts rows 0 and 1 out of the column-major VIEW matrix on the CPU,
 * which is the same `normalize(view rowN)` the visible billboard stage
 * derives. `cutoff` is a cutout system's alpha cutoff and zero otherwise;
 * `axis` is the lock axis an axis-locked basis reads and the facing
 * system's zero vector otherwise.
 */
struct BillboardPickUniforms {
    std::array<float, 3> cam_right{};
    std::uint32_t base_id = 0;
    std::array<float, 3> cam_up{};
    float cutoff = 0.0f;
    std::array<float, 3> axis{};
    float pad = 0.0f;
};
static_assert(sizeof(BillboardPickUniforms) == 48, "the pin's billboard pick UBO is 48 bytes");

#if BBLITE_HAS_BILLBOARDS
/** One system's block, packed by the pin's `packBillboardPickUbo`. */
BillboardPickUniforms build_billboard_pick_uniforms(const std::array<float, 16>& view,
                                                    std::uint32_t base_id, float cutoff, Vec3 axis);
#endif

/** The pin's contributor gate: a hidden or empty system draws nothing. */
#if BBLITE_HAS_SPRITES
inline bool billboard_pick_draws(const BillboardSystemRecord& system) {
    return system.visible && system.count != 0;
}

#if BBLITE_HAS_BILLBOARDS
/**
 * How many of the visible stage's instance attributes the pick stage
 * reads: locations 0..5, everything but the colour lane the pick fragment
 * replaces with an id. The table is the billboard lowerer's, generated
 * from the RENDER pipeline's own byte offsets -- which is exactly what the
 * pick module's private copy of them must equal -- so the agreement is
 * asserted at compile time rather than re-checked per pipeline build.
 */
inline constexpr std::size_t billboard_pick_attributes = 6;
static_assert(upstream::billboard_instance_attributes.size() >= billboard_pick_attributes,
              "the pinned billboard layout dropped an attribute the pick stage reads");
static_assert(
    [] {
        for (std::size_t index = 0; index < billboard_pick_attributes; ++index) {
            if (upstream::billboard_instance_attributes[index].shader_location != index) {
                return false;
            }
        }
        return true;
    }(),
    "the pinned billboard attributes no longer arrive in location order");
#endif

/**
 * The composed module a system's orientation picks through.
 *
 * Only the vertex stage forks -- the pin's `makeBillboardPickWgsl` swaps
 * `basis()` and nothing else -- so the second orientation deploys one
 * vertex stem and shares the first's fragment, exactly as the visible
 * billboard pair does.
 */
inline const char* billboard_pick_vertex_stem(BillboardOrientation orientation) {
    return orientation == BillboardOrientation::axis_locked ? "picking-billboard-axis-locked.vert"
                                                            : "picking-billboard.vert";
}
inline const char* billboard_pick_fragment_stem() { return "picking-billboard.frag"; }

/** One billboard system the pick pass draws, and the range it owns. */
struct PickBillboardCandidate {
    /** Index into `scene.billboard_systems`, which keys per-system GPU state. */
    std::size_t system_index = 0;
    std::uint32_t base_id = 0;
    std::uint32_t count = 0;
    BillboardOrientation orientation = BillboardOrientation::facing;
    Vec3 axis{};
};

/**
 * The billboard half of the contributor walk, decided once for both
 * backends -- the twin of `collect_pick_mesh_candidates` below, and for
 * the same reason: the id policy is what the two backends must not drift
 * on, since `pick_id - base_id` is the sprite index a scene reads back.
 *
 * The pin gives one system `system.count` consecutive ids and lets a
 * hidden or empty one CONSUME its range without drawing, so the mapping
 * stays positional (`pick-contributor.ts`: "a hidden/empty entity still
 * consumes its ids"). Both halves live here; each backend keeps only its
 * pipeline and bind mechanics.
 */
void collect_pick_billboard_candidates(
    const Engine& engine, const Scene& scene, std::vector<PickRange>& ranges,
    std::uint32_t& next_id,
    // The caller's scratch, cleared here and refilled: a pick runs per
    // pointer event, so the list keeps its capacity across picks.
    std::vector<PickBillboardCandidate>& candidates);

#endif

/** Refuse unsupported contributors only when this scene's pick pass draws them. */
void validate_pick_contributors([[maybe_unused]] const Engine& engine,
                                [[maybe_unused]] const Scene& scene, [[maybe_unused]] bool detailed,
                                bool pick_sources);

#if BBLITE_HAS_SPLATS
/** `encodeIdToColor`, stored through the cloud's F32 picking block. */
std::array<float, 3> encode_pick_id_to_color(std::uint32_t id);
#endif

/**
 * One pick's readback layout, stated once for both backends.
 *
 * Every attachment is copied into its own 256-byte row of one staging
 * buffer, so the row count and the buffer size are the same fact -- and a
 * mismatch between the buffer's SIZE and the map's LENGTH truncates
 * silently rather than failing, which is why neither backend spells it.
 */
inline constexpr std::uint32_t pick_readback_row = 256;
inline constexpr std::uint32_t pick_color_targets = BBLITE_HAS_DETAILED_PICKING ? 3u : 2u;
inline constexpr std::uint32_t pick_depth_offset = 1u * pick_readback_row;
inline constexpr std::uint32_t pick_detail_offset = 2u * pick_readback_row;
inline constexpr std::uint64_t pick_staging_bytes =
    static_cast<std::uint64_t>(pick_color_targets) * pick_readback_row;

#if BBLITE_HAS_DETAILED_PICKING
/**
 * The detailed attachment's one texel, read the way the pin's
 * `readDetailTarget` reads it.
 *
 * The pin's detailed fragment packs
 * `vec4u(primitiveIndex, bitcast<u32>(local.x), .y, .z)` into an
 * `rgba32uint` target, and the readback reinterprets the same sixteen
 * bytes twice: lane 0 as a `u32` where `0xffffffff` is "no primitive",
 * lanes 1..3 back through `Float32Array` as the interpolated position.
 * Both backends copy that texel and decode it here, once.
 */
/**
 * The primitive-index lane's "no primitive" clear, spelled once.
 *
 * The pin clears the detail attachment's red lane to 0xFFFFFFFF and
 * `decode_pick_detail` tests for exactly that word. Backends state a clear
 * as a colour, and SDL's is float: 4294967295.0f is not representable, so
 * writing the literal there rounds to 4294967296.0 and the two backends
 * clear to different words. Kept as a double here and converted by each
 * backend, so the value has one home and the rounding is visible where it
 * happens rather than hidden in a literal.
 */
inline constexpr std::uint32_t pick_detail_no_primitive = 0xFFFFFFFFu;
inline constexpr double pick_detail_clear_red = static_cast<double>(pick_detail_no_primitive);

PickDetailReadback decode_pick_detail(const std::uint8_t* texel);

/**
 * `picker._detailedPicking`, which `enableDetailedPicking` arms.
 *
 * Read per pick rather than per picker resource, because it selects the
 * pin's second pipeline module and a third attachment for THAT call.
 */
inline bool detailed_pick_armed(const Engine& engine, GpuPickerHandle picker) {
    return picker.value < engine.gpu_pickers.size() &&
           handle_at(engine.gpu_pickers, picker).detailed;
}
#endif

/**
 * The pin's clears for the pick pass's colour attachments, in attachment
 * order: 0 is "nothing here" for the id, 1 is "nothing here" for the depth
 * colour under reverse-Z, and the detail lane's no-primitive word. The depth
 * buffer clears to 0. Each backend states these in its own colour type.
 */
inline constexpr std::array<std::array<double, 4>, pick_color_targets> pick_color_clears{{
    {0.0, 0.0, 0.0, 0.0},
    {1.0, 0.0, 0.0, 0.0},
#if BBLITE_HAS_DETAILED_PICKING
    {pick_detail_clear_red, 0.0, 0.0, 0.0},
#endif
}};
inline constexpr double pick_depth_clear = 0.0;

/** One pick's staging rows, decoded: the id, the depth colour, the detail. */
struct PickReadback {
    std::uint32_t pick_id = 0;
    float depth = 1.0f;
#if BBLITE_HAS_DETAILED_PICKING
    PickDetailReadback detail{};
#endif
};

/**
 * The pin's readback of the mapped staging buffer: `pickId` through its own
 * lowered decode, `depth` as the row's first float, and the detail texel
 * only when the pick was detailed. Both backends map the same layout.
 */
PickReadback decode_pick_readback(const std::uint8_t* staging, [[maybe_unused]] bool detailed);

/**
 * Clears `engine.pick_hook` when the frame loop's scope ends, however it
 * ends. The hook holds the backend state, the scene and the render plan
 * by reference, all of which die with that scope; clearing it on
 * destruction makes that structural in both exit arms instead of relying
 * on a copy of the reset in each.
 */
class PickHookGuard {
public:
    explicit PickHookGuard(Engine& engine) : engine_(engine) {}
    PickHookGuard(const PickHookGuard&) = delete;
    PickHookGuard& operator=(const PickHookGuard&) = delete;
    ~PickHookGuard() { engine_.pick_hook = nullptr; }

private:
    Engine& engine_;
};

#endif

#if BBLITE_HAS_PBR_RENDERER
#if BBLITE_HAS_PICKING
#if BBLITE_DEFORM_PICKING
/** Match the pin's skeleton/morph projection key for this live candidate. */
int pick_mesh_projection(const Engine& engine, const MeshRecord& mesh);

#endif

/** One mesh the pick pass will draw: its plan item and its uniform block. */
struct PickMeshCandidate {
    std::size_t item_index = 0;
    PickMeshUniforms uniforms{};
#if BBLITE_GPU_INSTANCING
    /** The advanced pipeline draws one invocation and id per active row. */
    bool thin = false;
    std::uint32_t instance_count = 1;
#endif
#if BBLITE_DEFORM_PICKING
    /** Index in the generated projection table; -1 is the affine pipeline. */
    int deform = -1;
#endif
};

/**
 * The render-plan walk both pick passes share: which meshes are drawn, in
 * which order, under which id, and with which world matrix.
 *
 * The RENDER PLAN, not `scene.meshes`: the backend mesh list is indexed by
 * plan item, and the plan skips a mesh with no geometry -- so the two agree
 * only while nothing has been skipped or removed. Walking the plan is also
 * what makes a scene's own `removeFromScene` visible to a later pick, since
 * `rematch_render_meshes` rebuilds both together. `has_geometry` is the one
 * backend fact in the walk (whether the row's GPU buffers exist); the
 * generated pick predicate over the live record, the world-or-identity
 * selection and the id/range assignment are decided here, once, so the two
 * backends cannot drift on which mesh answers a pick.
 */
std::optional<std::size_t> picker_scene_index(const Engine& engine, GpuPickerHandle picker,
                                              const std::vector<std::shared_ptr<Scene>>& scenes);

template <typename HasGeometry>
inline std::vector<PickMeshCandidate>
collect_pick_mesh_candidates(const Engine& engine, [[maybe_unused]] const Scene& scene,
                             const upstream::RenderPlan& render_plan, std::size_t gpu_mesh_count,
                             const HasGeometry& has_geometry, std::vector<PickRange>& ranges,
                             std::uint32_t& next_id, const Engine::PickFilter* filter = nullptr,
                             [[maybe_unused]] bool detailed = false) {
    std::vector<PickMeshCandidate> candidates;
    for (std::size_t item_index = 0;
         item_index < render_plan.items.size() && item_index < gpu_mesh_count; ++item_index) {
        const MeshHandle handle = render_plan.items[item_index].mesh;
        if (!has_geometry(item_index))
            continue;
        // A mesh the pin's picker would not take never enters the pass, so
        // it can neither answer a pick nor occlude one behind it. The
        // predicate is generated, and it reads the live record rather than
        // the plan's snapshot of it.
        if (!upstream::pick_candidate(handle_at(engine.meshes, handle))) {
            continue;
        }
        // The pin's `pickFilter` arm: a mesh the supplied filter refuses
        // neither answers nor occludes, and consumes no id.
        if (filter && !(*filter)(handle)) {
            continue;
        }
        PickMeshCandidate candidate;
        candidate.item_index = item_index;
        const MeshRecord& pick_mesh = handle_at(engine.meshes, handle);
#if BBLITE_GPU_INSTANCING
        candidate.thin = pick_mesh.thin_instanced;
        if (candidate.thin) {
            candidate.instance_count =
                static_cast<std::uint32_t>(thin_instance_active_count(pick_mesh));
            if (candidate.instance_count == 0)
                continue;
            if (detailed)
                throw std::runtime_error(
                    "Detailed picking requires the selected thin-instance world matrix.");
        }
#endif
#if BBLITE_DEFORM_PICKING
        candidate.deform = pick_mesh_projection(engine, pick_mesh);
#if BBLITE_GPU_INSTANCING
        if (candidate.thin && candidate.deform >= 0) {
            throw std::runtime_error("thin-instance deformation picking is not supported");
        }
#endif
#endif
        // `gpu-picker.ts` copies `mesh.worldMatrix` as stored, with no
        // floating-origin offset: the projection arms compose the instance
        // matrix or the palette on top of it in the vertex stage.
        candidate.uniforms.world = upstream::mesh_world_matrix(engine, pick_mesh);
        candidate.uniforms.pick_id = next_id;
        candidates.push_back(candidate);
        const std::uint32_t id_count =
#if BBLITE_GPU_INSTANCING
            candidate.thin ? candidate.instance_count :
#endif
                           1u;
        ranges.push_back(
            {next_id, PickedNodeKind::mesh, handle.value, id_count, handle.generation});
        next_id += id_count;
    }
    return candidates;
}

#if BBLITE_HAS_DETAILED_PICKING
/**
 * The tail of the pin's own `pickAsyncImpl` for a detailed pick, decided
 * once for both backends -- the twin of `collect_pick_mesh_candidates`
 * above, and for the same reason: what the CPU solve is handed is what
 * the two backends must not drift on.
 *
 * The ray is the pin's `info.ray = detailed ? pickRay : null`, and the
 * world is `mesh.worldMatrix`, the matrix the pass drew the mesh's local
 * lanes through. Upstream snapshots it before an asynchronous readback;
 * here the draw and the readback are one synchronous call, so
 * `copyDetailedWorldMatrix`'s reason -- an animation tick between them --
 * cannot arise.
 */
void finish_detailed_pick(const Engine& engine, PickingInfo& info,
                          const PickDetailReadback& readback,
                          const std::array<float, 16>& view_projection, double sample_x,
                          double sample_y, double width, double height);
#endif

/**
 * The backend-neutral preamble of one GPU pick over the scene the picker
 * renders (`picker_scene_index`): whether the pick is detailed, the camera,
 * and the pin's own pointer mapping and scene block (`map_pick_pointer`,
 * lowered from `pickAsyncImpl`). Each backend keeps its pipelines, uploads,
 * draws and the staging copy; what they share is decided here once.
 */
struct PickRequest {
    const CameraRecord* camera = nullptr;
    bool detailed = false;
    upstream::PickPointer pointer{};
    PickSceneUniforms scene_uniforms{};
};

/** Empty where the pin answers the empty info: no camera, or a miss. */
std::optional<PickRequest> prepare_gpu_pick(const Engine& engine,
                                            [[maybe_unused]] GpuPickerHandle picker,
                                            const Scene& scene, double x, double y);

/**
 * The tail of `pickAsyncImpl` once the staging rows are read: the id
 * against what was drawn, the picked point reconstructed from the depth at
 * the pick's own sample, and a detailed pick's ray and solve inputs.
 */
PickingInfo resolve_gpu_pick([[maybe_unused]] const Engine& engine, const PickRequest& request,
                             const std::vector<PickRange>& ranges, const PickReadback& readback);
#endif
#endif

} // namespace bbl::pal
