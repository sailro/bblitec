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

#include <bblite/ts_runtime.hpp>

#include <cstddef>

namespace bbl::upstream {

struct ParsedGlbContainer {
    ts::JsonValue json;
    std::size_t json_offset = 0;
    std::size_t json_length = 0;
    std::size_t bin_offset = 0;
    std::size_t bin_length = 0;
};

ParsedGlbContainer parse_glb_container(const ts::ArrayBuffer& buffer);

} // namespace bbl::upstream
`,
            source: `// ${this.context.provenance(modulePath, symbolName)}
#include <bblite/upstream/gltf_glb_parser.hpp>

#include <stdexcept>
#include <string>

namespace bbl::upstream {

ParsedGlbContainer parse_glb_container(const ts::ArrayBuffer& buffer) {
    const ts::DataView view(buffer);
    if (view.get_uint32(0, true) != ${hex(magic)}) {
        throw std::runtime_error("Not a valid GLB file");
    }
    std::size_t offset = ${headerSize};
    const std::size_t json_length = view.get_uint32(offset, true);
    if (view.get_uint32(offset + 4, true) != ${hex(jsonType)}) {
        throw std::runtime_error("First GLB chunk is not JSON");
    }
    const std::size_t json_offset = offset + 8;
    ts::Uint8Array json_bytes(buffer, json_offset, json_length);
    std::string json_string = ts::TextDecoder{}.decode(json_bytes);
    while (!json_string.empty() && (json_string.back() == '\\0' || json_string.back() == ' ')) {
        json_string.pop_back();
    }
    ts::JsonValue json = ts::json_parse(json_string);
    offset += 8 + json_length;
    const std::size_t bin_length = view.get_uint32(offset, true);
    if (view.get_uint32(offset + 4, true) != ${hex(binType)}) {
        throw std::runtime_error("Second GLB chunk is not BIN");
    }
    const std::size_t bin_offset = offset + 8;
    if (json_offset + json_length > buffer.byte_length() || bin_offset + bin_length > buffer.byte_length()) {
        throw std::runtime_error("Truncated GLB chunk.");
    }
    return ParsedGlbContainer{std::move(json), json_offset, json_length, bin_offset, bin_length};
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
#include <bblite/pal_gltf.hpp>
#include <bblite/runtime.hpp>
#include <bblite/ts_runtime.hpp>

namespace bbl {

AssetHandle load_gltf(Engine& engine, const std::string& path) {
    ts::ArrayBuffer buffer = ts::await(pal::fetch_array_buffer(path));
    return pal::load_glb(engine, buffer, path);
}

} // namespace bbl
`,
        };
    }
}
