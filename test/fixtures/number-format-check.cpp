#include <bblite/js_json.hpp>
#include <bit>
#include <fstream>
#include <iostream>

int main(int argc, char** argv) {
    assert(argc == 2);
    std::ifstream input(argv[1]);
    assert(input);
    unsigned count = 0;
    for (std::string line; std::getline(input, line); ++count) {
        const auto first = line.find('\t'), second = line.find('\t', first + 1);
        assert(first != std::string::npos && second != std::string::npos);
        std::uint64_t bits = 0;
        const auto parsed = std::from_chars(line.data(), line.data() + first, bits, 16);
        assert(parsed.ec == std::errc{} && parsed.ptr == line.data() + first);
        const double value = std::bit_cast<double>(bits);
        const auto expected = line.substr(first + 1, second - first - 1);
        const auto actual = bbl::js::number_to_string(value);
        if (actual != expected) {
            std::cerr << line.substr(0, first) << ": expected " << expected << ", received "
                      << actual << '\n';
            return 1;
        }
        assert(bbl::js::concat("n=", bbl::js::NumberPart(value), ";") == "n=" + expected + ";");
        const auto third = line.find('\t', second + 1);
        assert(third != std::string::npos);
        assert(bbl::js::json_stringify(value) == line.substr(second + 1, third - second - 1));
        auto start = third + 1;
        for (const int digits : {0, 1, 2, 3, 20, 50, 100}) {
            const auto end = line.find('\t', start);
            const auto expected_fixed = line.substr(start, end - start);
            const auto fixed = bbl::js::number_to_fixed(value, digits);
            if (fixed != expected_fixed) {
                std::cerr << line.substr(0, first) << ".toFixed(" << digits << "): expected "
                          << expected_fixed << ", received " << fixed << '\n';
                return 1;
            }
            start = end == std::string::npos ? line.size() : end + 1;
        }
    }
    assert(input.eof() && count > 8192);
}
