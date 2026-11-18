// Shared billboard pass bookkeeping: which systems have passes, when an
// instance buffer grows, and when its contents are re-uploaded.
#pragma once

#include <bblite/runtime.hpp>
#include <array>
#include <cstddef>
#include <cstdint>
#include <utility>
#include <vector>

namespace bbl::pal {

/** The contents and camera inputs last uploaded by either backend. */
struct BillboardUploadStamp {
    std::array<float, 16> view{};
    std::uint32_t count = 0;
    std::uint64_t instance_version = 0;
    bool uploaded = false;
#if BBLITE_FLOATING_ORIGIN
    Vec3d fo_offset{};
#endif
};

/** Dynamic systems may refill the same count; their version identifies the rows.
 * Cutout systems keep insertion order, so only transparent sorting needs the view. */
inline bool billboard_needs_upload(const BillboardSystemRecord& system,
                                   const BillboardUploadStamp& stamp,
                                   const std::array<float, 16>& view,
                                   [[maybe_unused]] Vec3d fo_offset) {
    if (system.count == 0)
        return false;
    if (!stamp.uploaded || stamp.count != system.count ||
        stamp.instance_version != system.instance_version) {
        return true;
    }
#if BBLITE_FLOATING_ORIGIN
    // The anchors are uploaded eye-relative, including unsorted cutout rows.
    // The pin includes this input through lightFoVersion / wrapRenderableForFO.
    if (stamp.fo_offset.x != fo_offset.x || stamp.fo_offset.y != fo_offset.y ||
        stamp.fo_offset.z != fo_offset.z) {
        return true;
    }
#endif
    const bool cutout = system.depth_mode == BillboardDepthMode::cutout;
    return !(cutout || stamp.view == view);
}

inline void stamp_billboard_upload(BillboardUploadStamp& stamp, const BillboardSystemRecord& system,
                                   const std::array<float, 16>& view,
                                   [[maybe_unused]] Vec3d fo_offset) {
    stamp.view = view;
    stamp.count = system.count;
    stamp.instance_version = system.instance_version;
    stamp.uploaded = true;
#if BBLITE_FLOATING_ORIGIN
    stamp.fo_offset = fo_offset;
#endif
}

/**
 * ensureBillboardInstanceBuffer: a system grown past the capacity its pass's
 * instance buffer holds draws from a new buffer holding every row.
 * `reallocate(capacity)` replaces the backend buffer; the pass then records
 * that capacity and forgets its upload, as the pin resets `_uploadedVersion`.
 */
template <class Pass, class Reallocate>
void ensure_billboard_instance_capacity(const BillboardSystemRecord& system, Pass& pass,
                                        Reallocate&& reallocate) {
    if (system.capacity <= pass.instance_capacity)
        return;
    reallocate(system.capacity);
    pass.instance_capacity = system.capacity;
    pass.upload_stamp = {};
}

/** Each collection member keeps its system's pass, or matches `passes.size()` if not built yet. */
template <class Pass>
std::vector<std::size_t> billboard_pass_matches(const std::vector<Pass>& passes,
                                                const std::vector<BillboardSystemHandle>& members) {
    std::vector<std::size_t> matches;
    matches.reserve(members.size());
    for (const BillboardSystemHandle member : members) {
        std::size_t index = 0;
        while (index < passes.size() && passes[index].system != member)
            ++index;
        matches.push_back(index);
    }
    return matches;
}

/**
 * The members `billboard_pass_matches` matched to none of `pass_count`
 * passes, in member order: what a follow builds.
 */
inline std::vector<BillboardSystemHandle>
billboard_members_without_pass(const std::vector<std::size_t>& matches, std::size_t pass_count,
                               const std::vector<BillboardSystemHandle>& members) {
    std::vector<BillboardSystemHandle> missing;
    for (std::size_t index = 0; index < members.size(); ++index)
        if (matches[index] == pass_count)
            missing.push_back(members[index]);
    return missing;
}

/**
 * Reorders `passes` to follow the members `matches` was computed for: each
 * member keeps its matched pass or takes the next of `built` (one per
 * `billboard_members_without_pass` entry, in that order), and a pass no
 * member keeps is dropped, which releases it.
 */
template <class Pass>
void adopt_billboard_passes(std::vector<Pass>& passes, const std::vector<std::size_t>& matches,
                            std::vector<Pass> built) {
    std::vector<Pass> followed;
    followed.reserve(matches.size());
    std::size_t next = 0;
    for (const std::size_t match : matches)
        followed.push_back(match < passes.size() ? std::move(passes[match])
                                                 : std::move(built.at(next++)));
    passes = std::move(followed);
}

/**
 * The passes follow the systems the scene draws. `addBillboardSystemToScene`
 * publishes a renderable when its scene builds, which advances the scene's
 * `renderable_version`, and the scene's render task rebinds whatever it holds
 * then (render-task-base.ts `_buildBindings`); so when that version moves,
 * every member without a pass gets one from `build(handle)` before the frame
 * draws, and a pass whose system left the scene is released.
 */
template <class Pass, class Build>
void follow_billboard_renderables(std::vector<Pass>& passes,
                                  const std::vector<BillboardSystemHandle>& members,
                                  Build&& build) {
    const std::vector<std::size_t> matches = billboard_pass_matches(passes, members);
    std::vector<Pass> built;
    for (const BillboardSystemHandle member :
         billboard_members_without_pass(matches, passes.size(), members))
        built.push_back(build(member));
    adopt_billboard_passes(passes, matches, std::move(built));
}

} // namespace bbl::pal
