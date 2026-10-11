#include <bblite/upstream/env_parse.hpp>

#include <cstdio>
#include <fstream>
#include <iterator>
#include <stdexcept>

int main(int argc, char** argv) {
    if (argc != 2)
        return 1;
    try {
        std::ifstream input(argv[1], std::ios::binary);
        if (!input)
            throw std::runtime_error("Cannot open environment fixture.");
        const std::vector<std::uint8_t> bytes{std::istreambuf_iterator<char>(input), {}};
        const auto parsed = bbl::upstream::parse_env_file(bytes);
        std::printf("%u %u", parsed.width, parsed.mip_count);
        for (const auto& face : parsed.faces) {
            std::printf(" [");
            for (const auto byte : face.bytes)
                std::printf("%u,", static_cast<unsigned>(byte));
            std::printf("]");
        }
        std::puts("");
    } catch (const std::exception& error) {
        std::fprintf(stderr, "%s\n", error.what());
        return 2;
    }
}
