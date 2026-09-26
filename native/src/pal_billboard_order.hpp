#pragma once
#include <bblite/features/has_billboards.hpp>
#if BBLITE_HAS_BILLBOARDS
#include <bblite/upstream/billboard_system.hpp>
#include <span>

namespace bbl::pal {
/** A draw-list-shaped borrow for backends that walk one interleaved mesh command. */
template <class Command> struct BorrowedDrawList {
    std::span<const Command> commands;
    explicit BorrowedDrawList(const Command& command) : commands(&command, 1) {}
};

/** Merge retained GPU rows through the pin's center and transparent comparator. */
template <class DrawList, class Billboards, class View>
std::vector<upstream::BillboardOrderItem>
ordered_scene_billboards(const DrawList& meshes, Engine& engine, const Billboards& billboards,
                         const CameraRecord* camera, const View& view) {
    std::vector<upstream::BillboardOrderItem> result;
    result.reserve(meshes.commands.size() + billboards.size());
    for (std::size_t index = 0; index < meshes.commands.size(); ++index) {
        const auto& command = meshes.commands[index];
        const auto world =
            upstream::mesh_world_matrix(engine, handle_at(engine.meshes, command.item.mesh));
        const std::array<double, 3> center{world[12], world[13], world[14]};
        result.push_back({index, false,
                          camera ? upstream::billboard_sort_distance(center, view) : 0,
                          command.item.order});
    }
    for (std::size_t index = 0; index < billboards.size(); ++index) {
        auto& system = handle_at(engine.billboard_systems, billboards[index].system);
        if (system.depth_mode != BillboardDepthMode::transparent)
            continue;
        upstream::refresh_billboard_world_center(system);
        // The source's drawSystem rejects these bindings before issuing a draw.
        if (!system.visible || system.count == 0 || system.drawable_count == 0)
            continue;
        result.push_back({index, true,
                          camera ? upstream::billboard_sort_distance(system.world_center, view) : 0,
                          system.order});
    }
    if (result.size() == meshes.commands.size())
        return result;
    if (!camera && !meshes.commands.empty()) {
        throw std::runtime_error(
            "Mixed transparent mesh/billboard draws without a camera require retained source binding order.");
    }
    if (camera)
        std::stable_sort(result.begin(), result.end(), [](const auto& left, const auto& right) {
            return upstream::compare_billboard_order(left, right) < 0;
        });
    for (std::size_t index = 1; index < result.size(); ++index) {
        const auto& left = result[index - 1];
        const auto& right = result[index];
        if (left.billboard != right.billboard &&
            upstream::compare_billboard_order(left, right) == 0) {
            // Array.sort is stable across frames. The two retained native lists
            // do not carry the source's deferred-build completion or prior mixed
            // binding order, so manufacturing a mesh-first tie would be incorrect.
            throw std::runtime_error(
                "Transparent mesh/billboard draws with equal depth and order require retained source binding order.");
        }
    }
    return result;
}
} // namespace bbl::pal
#endif
