import { LoweredSource, LoweringContext } from "./context.js";

export class GltfLowerer {
    public constructor(private readonly context: LoweringContext) {}

    public lowerGlbParser(): LoweredSource {
        const modulePath = "src/loader-gltf/gltf-glb-parser.ts";
        const symbolName = "parseGlbContainer";
        const source = this.context.store.getSource(modulePath);
        const magic = this.context.extractNumber(
            source,
            /magic !== (0x[0-9a-fA-F]+)/,
            "GLB magic",
        );
        const jsonType = this.context.extractNumber(
            source,
            /jsonType !== (0x[0-9a-fA-F]+)/,
            "GLB JSON chunk type",
        );
        const binType = this.context.extractNumber(
            source,
            /binType !== (0x[0-9a-fA-F]+)/,
            "GLB BIN chunk type",
        );
        const headerSize = this.context.extractNumber(
            source,
            /let offset = ([0-9]+)/,
            "GLB header size",
        );
        const hex = (value: number): string => `0x${value.toString(16)}`;
        return {
            modulePath,
            symbolName,
            header: `#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

namespace bbl::upstream {

struct ParsedGlbContainer {
    std::size_t json_offset = 0;
    std::size_t json_length = 0;
    std::size_t bin_offset = 0;
    std::size_t bin_length = 0;
};

ParsedGlbContainer parse_glb_container(const std::vector<std::uint8_t>& bytes);

} // namespace bbl::upstream
`,
            source: `// ${this.context.provenance(modulePath, symbolName)}
#include <bblite/upstream/gltf_glb_parser.hpp>

#include <stdexcept>

namespace bbl::upstream {
namespace {

std::uint32_t read_u32(const std::vector<std::uint8_t>& bytes, std::size_t offset) {
    if (offset + 4 > bytes.size()) throw std::runtime_error("Truncated GLB file.");
    return static_cast<std::uint32_t>(bytes[offset]) |
        (static_cast<std::uint32_t>(bytes[offset + 1]) << 8) |
        (static_cast<std::uint32_t>(bytes[offset + 2]) << 16) |
        (static_cast<std::uint32_t>(bytes[offset + 3]) << 24);
}

} // namespace

ParsedGlbContainer parse_glb_container(const std::vector<std::uint8_t>& bytes) {
    if (read_u32(bytes, 0) != ${hex(magic)}) {
        throw std::runtime_error("Not a valid GLB file");
    }
    std::size_t offset = ${headerSize};
    const std::size_t json_length = read_u32(bytes, offset);
    if (read_u32(bytes, offset + 4) != ${hex(jsonType)}) {
        throw std::runtime_error("First GLB chunk is not JSON");
    }
    const std::size_t json_offset = offset + 8;
    offset += 8 + json_length;
    const std::size_t bin_length = read_u32(bytes, offset);
    if (read_u32(bytes, offset + 4) != ${hex(binType)}) {
        throw std::runtime_error("Second GLB chunk is not BIN");
    }
    const std::size_t bin_offset = offset + 8;
    if (json_offset + json_length > bytes.size() || bin_offset + bin_length > bytes.size()) {
        throw std::runtime_error("Truncated GLB chunk.");
    }
    return ParsedGlbContainer{json_offset, json_length, bin_offset, bin_length};
}

} // namespace bbl::upstream
`,
        };
    }

    public lowerLoaderAdapter(): LoweredSource {
        const modulePath = "src/loader-gltf/load-gltf.ts";
        const symbolName = "loadGltf";
        const source = this.context.store.getSource(modulePath);
        for (const marker of [
            "export async function loadGltf",
            "fetchGltfAsset(source)",
            "loadGltfFeatures(json)",
        ]) {
            if (!source.includes(marker)) throw new Error(`Upstream glTF loader contract changed: ${marker}.`);
        }
        return {
            modulePath,
            symbolName,
            header: "",
            source: `// ${this.context.provenance(modulePath, symbolName)}
#include <bblite/pal.hpp>
#include <bblite/runtime.hpp>

namespace bbl {

AssetHandle load_gltf(Engine& engine, const std::string& path) {
    return pal::load_glb(engine, path);
}

} // namespace bbl
`,
        };
    }
}
