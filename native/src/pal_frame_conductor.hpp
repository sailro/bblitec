#pragma once

#include <optional>
#include <type_traits>

namespace bbl::pal {

enum class FramePreparation { ready, stop, restart, skip };
enum class FrameOutcome { stopped, skipped, rendered, restart };
enum class FrameAcquirePhase { before_update, before_uploads, before_encoding };

constexpr std::optional<FrameOutcome> frame_interruption(FramePreparation preparation) {
    switch (preparation) {
        case FramePreparation::stop: return FrameOutcome::stopped;
        case FramePreparation::restart: return FrameOutcome::restart;
        case FramePreparation::skip: return FrameOutcome::skipped;
        case FramePreparation::ready: return std::nullopt;
    }
    return std::nullopt;
}

/** Order a renderer's frame phases while preserving its surface/update boundary. */
template <typename Renderer>
FrameOutcome conduct_frame(Renderer& renderer) {
    if (!renderer.keep_running()) return FrameOutcome::stopped;
    if (const auto outcome = frame_interruption(renderer.prepare())) return *outcome;
    if constexpr (Renderer::acquire_phase == FrameAcquirePhase::before_update)
        if (!renderer.acquire()) return FrameOutcome::skipped;
    if (const auto outcome = frame_interruption(renderer.update())) return *outcome;
    if constexpr (Renderer::acquire_phase == FrameAcquirePhase::before_uploads)
        if (!renderer.acquire()) return FrameOutcome::skipped;
    renderer.synchronize();
    if constexpr (Renderer::acquire_phase == FrameAcquirePhase::before_encoding)
        if (!renderer.acquire()) return FrameOutcome::skipped;
    renderer.encode();
    if constexpr (std::is_same_v<decltype(renderer.present()), FramePreparation>) {
        if (const auto outcome = frame_interruption(renderer.present())) return *outcome;
    } else {
        renderer.present();
    }
    renderer.complete();
    return FrameOutcome::rendered;
}

} // namespace bbl::pal
