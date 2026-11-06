#pragma once

#include "pal_gpu_frame.hpp"

#include <optional>
#include <type_traits>
#include <utility>

namespace bbl::pal {

enum class FramePreparation { ready, stop, restart, skip };
/** `frozen`: the engine is stopped, so the frame drew nothing and its canvas keeps the last one. */
enum class FrameOutcome { stopped, skipped, rendered, restart, frozen };
enum class FrameAcquirePhase { before_update, before_uploads, before_encoding };

/**
 * Whether a frame completes its animation frame: a frozen one does as a
 * drawn one would, since the canvas's last frame stands for it.
 */
constexpr bool frame_drawn(FrameOutcome outcome) {
    return outcome == FrameOutcome::rendered || outcome == FrameOutcome::frozen;
}

constexpr std::optional<FrameOutcome> frame_interruption(FramePreparation preparation) {
    switch (preparation) {
    case FramePreparation::stop:
        return FrameOutcome::stopped;
    case FramePreparation::restart:
        return FrameOutcome::restart;
    case FramePreparation::skip:
        return FrameOutcome::skipped;
    case FramePreparation::ready:
        return std::nullopt;
    }
    return std::nullopt;
}

/** The frame from its update on: what the engine's animation-frame function renders. */
template <typename Renderer> FrameOutcome conduct_frame_render(Renderer& renderer) {
    if (const auto outcome = frame_interruption(renderer.update()))
        return *outcome;
    if constexpr (Renderer::acquire_phase == FrameAcquirePhase::before_uploads)
        if (!renderer.acquire())
            return FrameOutcome::skipped;
    renderer.synchronize();
    if constexpr (Renderer::acquire_phase == FrameAcquirePhase::before_encoding)
        if (!renderer.acquire())
            return FrameOutcome::skipped;
    renderer.encode();
    if constexpr (std::is_same_v<decltype(renderer.present()), FramePreparation>) {
        if (const auto outcome = frame_interruption(renderer.present()))
            return *outcome;
    } else {
        renderer.present();
    }
    renderer.complete();
    return FrameOutcome::rendered;
}

/**
 * A frame once the application wrote `engine._renderFn`: the browser turn
 * runs the RAF callbacks registered before `startEngine`, then the function
 * the previous frame armed (a wrapper whose inner function is the render
 * above), then the ones registered after. A frame that armed nothing (the
 * wrapper never ran the render, or `_renderFn` was cleared) schedules no
 * further frame, so the loop ends.
 */
template <typename Renderer> FrameOutcome conduct_armed_frame(Renderer& renderer, Engine& engine) {
    auto armed = std::exchange(engine.armed_render_function, {});
    if (!armed || !renderer.begin_animation_turn())
        return FrameOutcome::stopped;
    struct Turn {
        Engine& engine;
        ~Turn() {
            engine.animation_turn_conducted = false;
            engine.conducted_render = nullptr;
        }
    } turn{engine};
    engine.animation_turn_conducted = true;
    std::optional<FrameOutcome> outcome;
    engine.conducted_render = [&renderer, &outcome] {
        if (!outcome)
            outcome = conduct_frame_render(renderer);
    };
    armed(engine.animation_frame_timestamp_ms);
    if (!outcome)
        return FrameOutcome::stopped;
    if (*outcome == FrameOutcome::rendered)
        finish_animation_turn(engine);
    return *outcome;
}

/** Order a renderer's frame phases while preserving its surface/update boundary. */
template <typename Renderer> FrameOutcome conduct_frame(Renderer& renderer, Engine& engine) {
    if (!renderer.keep_running())
        return FrameOutcome::stopped;
    if (const auto outcome = frame_interruption(renderer.prepare()))
        return *outcome;
    // `stopEngine` cancels the pin's animation frame: no later frame renders
    // and the canvas keeps what it last drew, so nothing a frame would run --
    // callbacks, tasks, temporal history -- advances again. A frame that
    // begins stopped draws nothing; `freeze` hands the captures still
    // waiting their frozen image. A renderer holding no image of its own
    // answers false and draws the frame once more for them.
    if (engine.stopped && renderer.freeze())
        return FrameOutcome::frozen;
    if constexpr (Renderer::acquire_phase == FrameAcquirePhase::before_update)
        if (!renderer.acquire())
            return FrameOutcome::skipped;
    return engine.render_function_written ? conduct_armed_frame(renderer, engine)
                                          : conduct_frame_render(renderer);
}

} // namespace bbl::pal
