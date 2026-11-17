#pragma once

// What both backends' screenshot readback fixtures share: the texels the test
// generates (`cases.hpp`: `width`, `height` and `texels`, tightly packed in
// memory order), and the line a format's readback prints.

#include "../webgpu-subset/fixture-require.hpp"

#include <bblite/pal_screenshot.hpp>

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <span>
#include <string>

namespace screenshot_check {

/** Prints `<label> <hex>`: the unpacked image of a readback of `bytes_per_row`-byte rows. */
inline void print_unpacked(const char* label, std::span<const std::uint8_t> rows,
                           std::uint32_t width, std::uint32_t height, std::uint32_t bytes_per_row,
                           bool bgra) {
    const bbl::js::U8CArray data =
        bbl::upstream::unpack_screenshot(rows, width, height, bytes_per_row, bgra);
    std::string hex;
    static constexpr char digits[] = "0123456789abcdef";
    for (std::size_t index = 0; index < data.size(); ++index) {
        const std::uint8_t byte = data[index];
        hex += digits[byte >> 4];
        hex += digits[byte & 15];
    }
    std::printf("%s %u %s\n", label, bytes_per_row, hex.c_str());
}

} // namespace screenshot_check
