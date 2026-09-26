#include "pal_ui_length_math.hpp"

#include <bit>
#include <cassert>
#include <charconv>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

// The CSS decimal parser every target provides converts exactly as MSVC's
// floating-point std::from_chars does, so Windows UI layouts stay byte-identical.

namespace {

std::uint64_t state = 0x9e3779b97f4a7c15ULL;
std::uint64_t next() {
    state ^= state << 13;
    state ^= state >> 7;
    state ^= state << 17;
    return state;
}

std::string random_decimal() {
    std::string text;
    const auto integer_digits = next() % 8;
    for (std::uint64_t index = 0; index < integer_digits; ++index)
        text += static_cast<char>('0' + next() % 10);
    if (integer_digits == 0 || next() % 2) {
        text += '.';
        const auto fraction_digits = 1 + next() % 18;
        for (std::uint64_t index = 0; index < fraction_digits; ++index)
            text += static_cast<char>('0' + next() % 10);
    }
    if (next() % 4 == 0) {
        text += next() % 2 ? 'e' : 'E';
        const auto sign = next() % 3;
        if (sign == 1)
            text += '+';
        if (sign == 2)
            text += '-';
        text += std::to_string(next() % 40);
    }
    return text;
}

} // namespace

int main() {
    using bbl::pal::detail::css_decimal;
    std::vector<std::string> corpus = {"0",
                                       "1",
                                       "0.5",
                                       ".5",
                                       "5.",
                                       "100",
                                       "33.33",
                                       "0.1",
                                       "1e3",
                                       "2.5E-2",
                                       "12.345678901234567",
                                       "0.30000000000000004",
                                       "1e308",
                                       "4.9e-324"};
    for (int index = 0; index < 200000; ++index)
        corpus.push_back(random_decimal());
    std::size_t compared = 0;
    for (const auto& text : corpus) {
        double expected = 0;
        const auto reference = std::from_chars(text.data(), text.data() + text.size(), expected);
        std::size_t offset = 0;
        const auto parsed = css_decimal(text, offset);
        if (reference.ec != std::errc{}) {
            assert(!parsed);
            continue;
        }
        assert(parsed);
        assert(offset == static_cast<std::size_t>(reference.ptr - text.data()));
        assert(std::bit_cast<std::uint64_t>(*parsed) == std::bit_cast<std::uint64_t>(expected));
        ++compared;
    }
    // Units and exponents without digits stop the number where from_chars stops.
    for (const std::string text : {"2em", "3px", "1e", "1e+", "7vmin", "1.5e2vh"}) {
        double expected = 0;
        const auto reference = std::from_chars(text.data(), text.data() + text.size(), expected);
        std::size_t offset = 0;
        const auto parsed = css_decimal(text, offset);
        assert(parsed && *parsed == expected);
        assert(offset == static_cast<std::size_t>(reference.ptr - text.data()));
    }
    for (const std::string text : {"", ".", "e5", "-1", "+1", "1e400"}) {
        std::size_t offset = 0;
        assert(!css_decimal(text, offset) && offset == 0);
    }
    assert(bbl::pal::rml_css_length_math("width: calc(10vw + 2.5px)", 800, 600) ==
           "width: 82.500000px");
    assert(bbl::pal::rml_css_length_math("clamp(1px, 50vmin, 1e2px)", 800, 600) == "100.000000px");
    assert(bbl::pal::rml_css_length_math("width:min(36rem, 90vw)", 1280, 720, 16) ==
           "width:576.000000px");
    assert(bbl::pal::rml_css_length_math("width:min(36rem, 90vw)", 320, 720, 20) ==
           "width:288.000000px");
    for (const std::string text : {"font-size:min(2rem, 20px)", "--size:min(2rem, 20px)"}) {
        bool refused = false;
        try {
            static_cast<void>(bbl::pal::rml_css_length_math(text, 800, 600, 16));
        } catch (const std::runtime_error&) {
            refused = true;
        }
        assert(refused);
    }
    std::printf("%zu decimals identical\n", compared);
    return 0;
}
