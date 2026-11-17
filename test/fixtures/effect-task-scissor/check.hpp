#pragma once

// What both backends' effect-task scissor fixtures share: the cases the test
// generates (`cases.hpp`: the target extent and each case's scissor), the
// three colours a pixel can hold, and the line a case prints.

#include "../webgpu-subset/fixture-require.hpp"

#include <bblite/runtime.hpp>

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <string>

namespace effect_task_scissor {

/** One case: the task's `scissor`, absent when `present` is false. */
struct Case {
    bool present = false;
    double x = 0.0, y = 0.0, width = 0.0, height = 0.0;
};

/** The colours a pass leaves: an earlier fill, the task's clear, its draw. */
constexpr std::uint8_t stale[4] = {0, 0, 255, 255};
constexpr std::uint8_t cleared[4] = {0, 0, 0, 255};
constexpr std::uint8_t drawn[4] = {255, 0, 0, 255};

/** The effect task a case executes. */
inline bbl::FrameTaskRecord task_of(const Case& scissor) {
    bbl::FrameTaskRecord task;
    task.kind = bbl::FrameTaskKind::effect;
    task.effect.clear = true;
    if (scissor.present)
        task.effect_scissor =
            bbl::NormalizedViewport{scissor.x, scissor.y, scissor.width, scissor.height};
    return task;
}

/**
 * Prints `case <index> <rows>`: each row top first, `/`-separated, each pixel
 * `d` drawn, `c` cleared, `s` stale or `?` anything else.
 */
inline void print_case(std::size_t index, const std::uint8_t* rgba, std::size_t row_bytes,
                       std::uint32_t width, std::uint32_t height) {
    std::string rows;
    for (std::uint32_t y = 0; y < height; ++y) {
        if (y)
            rows += '/';
        for (std::uint32_t x = 0; x < width; ++x) {
            const std::uint8_t* pixel = rgba + y * row_bytes + x * 4;
            const auto is = [&](const std::uint8_t (&colour)[4]) {
                return pixel[0] == colour[0] && pixel[1] == colour[1] && pixel[2] == colour[2] &&
                       pixel[3] == colour[3];
            };
            rows += is(drawn) ? 'd' : is(cleared) ? 'c' : is(stale) ? 's' : '?';
        }
    }
    std::printf("case %zu %s\n", index, rows.c_str());
}

} // namespace effect_task_scissor
