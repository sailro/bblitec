#pragma once
#include "pal_gpu_common.hpp"
#include <bblite/features/external_renderables.hpp>
#include <bblite/features/has_billboards.hpp>
#if BBLITE_HAS_BILLBOARDS || BBLITE_EXTERNAL_RENDERABLES
#include <bblite/upstream/transparent_order.hpp>
#if BBLITE_HAS_BILLBOARDS
#include <bblite/upstream/billboard_system.hpp>
#endif
#if BBLITE_EXTERNAL_RENDERABLES
#include "pal_external_renderables.hpp"
#endif

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <span>
#include <stdexcept>
#include <type_traits>
#include <vector>

namespace bbl::pal {

/** The retained list a transparent draw lives in. */
enum class TransparentDrawKind : std::uint8_t { mesh, billboard, external };

/** One transparent binding: `_sortDistance`, `renderable.order`, and where its draw lives. */
struct TransparentDraw {
    std::size_t index;
    TransparentDrawKind kind;
    double distance;
    double order;
};

/**
 * `sortTransparentBindings` over a scene pass's transparent bucket, which the
 * renderers retain as one list per family: transparent meshes in draw-list
 * order, transparent billboard systems, and external renderables' bindings.
 * Each binding enters with the pin's `_sortDistance` from its `_worldCenter`
 * (0 without one, and 0 without a camera); with a camera the bucket sorts by
 * the pin's comparator. Meshes alone keep the render plan's draw-list order.
 */
template <class View> class TransparentOrder {
public:
    TransparentOrder(const CameraRecord* camera, const View& view) : camera_(camera), view_(view) {}

    template <class DrawList> void add_meshes(const DrawList& meshes, Engine& engine) {
        for (std::size_t index = 0; index < meshes.commands.size(); ++index) {
            const auto& command = meshes.commands[index];
            const auto world =
                upstream::mesh_world_matrix(engine, handle_at(engine.meshes, command.item.mesh));
            const std::array<double, 3> center{world[12], world[13], world[14]};
            add(index, TransparentDrawKind::mesh, &center, command.item.order);
        }
    }

#if BBLITE_HAS_BILLBOARDS
    template <class Billboards> void add_billboards(Engine& engine, const Billboards& billboards) {
        for (std::size_t index = 0; index < billboards.size(); ++index) {
            auto& system = handle_at(engine.billboard_systems, billboards[index].system);
            if (system.depth_mode != BillboardDepthMode::transparent)
                continue;
            upstream::refresh_billboard_world_center(system);
            // The source's drawSystem rejects these bindings before issuing a draw.
            if (!system.visible || system.count == 0 || system.drawable_count == 0)
                continue;
            add(index, TransparentDrawKind::billboard, &system.world_center, system.order);
        }
    }
#endif

#if BBLITE_EXTERNAL_RENDERABLES
    /**
     * The pass's bindings, in binding order. Text, Gaussian splat clouds and
     * depth-hosted sprite layers draw after this bucket instead of in it, so
     * a scene with them refuses external renderables, which must sort with
     * every transparent binding.
     */
    void add_externals(const ExternalRenderablePass& pass, const Scene& scene) {
        const bool drawn_outside = !scene.splat_meshes.empty() ||
                                   !scene.state->text_renderables.empty() ||
                                   !scene.depth_hosted_sprite_layers.empty();
        for (std::size_t index = 0; index < pass.size(); ++index) {
            const auto& renderable = pass.renderable(index);
            if (!renderable.transparent())
                continue;
            if (drawn_outside)
                throw std::runtime_error(
                    "Transparent external renderables sort with the scene pass's transparent "
                    "meshes and billboards; text, Gaussian splat clouds and depth-hosted sprite "
                    "layers draw outside that order.");
            const auto center = renderable.world_center();
            add(index, TransparentDrawKind::external, center ? &*center : nullptr,
                renderable.order());
        }
    }
#endif

    /** The bucket in draw order. */
    const std::vector<TransparentDraw>& sorted() {
        if (families_ == family(TransparentDrawKind::mesh) || families_ == 0)
            return draws_;
        const bool mixed = (families_ & (families_ - 1)) != 0;
        if (!camera_ && mixed)
            throw std::runtime_error("Mixed transparent families without a camera require "
                                     "retained source binding order.");
        if (camera_)
            std::stable_sort(draws_.begin(), draws_.end(), [](const auto& left, const auto& right) {
                return upstream::compare_transparent_order(left, right) < 0;
            });
        for (std::size_t index = 1; index < draws_.size(); ++index) {
            const auto& left = draws_[index - 1];
            const auto& right = draws_[index];
            if (left.kind != right.kind && upstream::compare_transparent_order(left, right) == 0) {
                // Array.sort is stable across frames. The retained family lists
                // do not carry the source's deferred-build completion or prior
                // mixed binding order, so manufacturing a tie order would be
                // incorrect.
                throw std::runtime_error("Transparent bindings of two families with equal depth "
                                         "and order require retained source binding order.");
            }
        }
        return draws_;
    }

private:
    static unsigned family(TransparentDrawKind kind) { return 1u << static_cast<unsigned>(kind); }

    void add(std::size_t index, TransparentDrawKind kind, const std::array<double, 3>* center,
             double order) {
        draws_.push_back(
            {index, kind, camera_ ? upstream::transparent_sort_distance(center, view_) : 0, order});
        families_ |= family(kind);
    }

    const CameraRecord* camera_;
    View view_;
    std::vector<TransparentDraw> draws_;
    unsigned families_ = 0;
};

/**
 * A pass's transparent bucket in `order`'s order, each binding drawn by its
 * family: a run of one mesh command, a billboard pass or an external
 * binding by its index.
 */
template <class Order, class DrawList, class DrawMeshes, class DrawBillboard, class DrawExternal>
void draw_transparent_bucket(Order& order, const DrawList& meshes, DrawMeshes&& draw_meshes,
                             DrawBillboard&& draw_billboard, DrawExternal&& draw_external) {
    for (const auto& item : order.sorted()) {
        switch (item.kind) {
        case TransparentDrawKind::mesh:
            draw_meshes(BorrowedDrawList{meshes.commands[item.index]});
            break;
        case TransparentDrawKind::billboard:
            draw_billboard(item.index);
            break;
        case TransparentDrawKind::external:
            draw_external(item.index);
            break;
        }
    }
}

#if BBLITE_EXTERNAL_RENDERABLES
/** One opaque external binding: its index, `renderable.order` and `_renderables` position. */
struct OpaqueExternalDraw {
    std::size_t index;
    double order;
    std::uint64_t publication;
};

/**
 * A pass's opaque bucket as `_buildBindings` sorts it (render-task-base.ts):
 * the pin's `compareBindingOrder` over its `_renderables` walk, stably. The
 * mesh list is in that order already (`order_draw_lists`, with direct draws
 * last, as the pin replays `_directBindings` after its bundle); the pass's
 * opaque external bindings merge into it by order, and an equal order by
 * `_renderables` position (`GpuExternalRenderable::publication` beside the
 * mesh's `source_identity`), which a binding numbered without one cannot
 * take. Meshes between two external bindings draw as one run.
 */
template <class DrawList, class DrawMeshes, class DrawExternal>
void draw_opaque_bucket(const DrawList& meshes, const ExternalRenderablePass* externals,
                        DrawMeshes&& draw_meshes, DrawExternal&& draw_external) {
    std::vector<OpaqueExternalDraw> pending;
    if (externals)
        for (std::size_t index = 0; index < externals->size(); ++index)
            if (const auto& renderable = externals->renderable(index); !renderable.transparent())
                pending.push_back({index, renderable.order(), renderable.publication});
    if (pending.empty()) {
        draw_meshes(meshes);
        return;
    }
    // The pass binds its externals in their `_renderables` order.
    std::stable_sort(pending.begin(), pending.end(), [](const auto& left, const auto& right) {
        return upstream::compare_binding_order(left, right) < 0;
    });
    const auto before = [](const OpaqueExternalDraw& external, const auto& item) {
        if (const double compared = upstream::compare_binding_order(external, item); compared != 0)
            return compared < 0;
        if (external.publication == 0 || item.source_identity == 0)
            throw std::runtime_error("An opaque external renderable and a mesh of equal order "
                                     "need their source binding order.");
        return external.publication < item.source_identity;
    };
    using Command = typename std::decay_t<decltype(meshes.commands)>::value_type;
    const std::span<const Command> commands(meshes.commands);
    std::size_t start = 0;
    const auto draw_run = [&](std::size_t end) {
        if (end > start)
            draw_meshes(BorrowedDrawList<Command>(commands.subspan(start, end - start)));
        start = end;
    };
    auto next = pending.begin();
    for (std::size_t index = 0; index < commands.size() && next != pending.end(); ++index)
        for (const auto& item = commands[index].item;
             next != pending.end() && (item.direct || before(*next, item)); ++next) {
            draw_run(index);
            draw_external(next->index);
        }
    draw_run(commands.size());
    for (; next != pending.end(); ++next)
        draw_external(next->index);
}
#endif

} // namespace bbl::pal
#endif
