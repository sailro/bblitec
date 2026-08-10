import { LoweredSource, LoweringContext } from "./context.js";
import { gltfLoaderCpp } from "./templates/gltf-loader-cpp.js";

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
        const samplerSource = this.context.store.getSource(
            "src/loader-gltf/gltf-sampler-desc.ts",
        );
        for (const marker of [
            "export async function loadGltf",
            "fetchGltfAsset(source)",
            "loadGltfFeatures(json)",
        ]) {
            if (!source.includes(marker)) throw new Error(`Upstream glTF loader contract changed: ${marker}.`);
        }
        const dielectricSource = this.context.store.getSource(
            "src/loader-gltf/gltf-ext-dielectric.ts",
        );
        const animationSource = this.context.store.getSource(
            "src/loader-gltf/gltf-animation.ts",
        );
        const skeletonSource = this.context.store.getSource(
            "src/loader-gltf/gltf-feature-skeleton.ts",
        );
        for (const marker of [
            "INTERP_CUBIC",
            "PATH_TRANSLATION",
            "PATH_ROTATION",
            "PATH_WEIGHTS",
            "inverseBindMatrices",
        ]) {
            if (!animationSource.includes(marker)) {
                throw new Error(
                    `Upstream glTF animation contract changed: ${marker}.`,
                );
            }
        }
        for (const marker of [
            "computeBoneTextureData",
            "createSkeleton",
        ]) {
            if (!skeletonSource.includes(marker)) {
                throw new Error(
                    `Upstream glTF skeleton contract changed: ${marker}.`,
                );
            }
        }
        for (const marker of [
            "KHR_materials_transmission",
            "KHR_materials_ior",
            "KHR_materials_volume",
            "((ior - 1) / (ior + 1)) ** 2 / 0.04",
            "attenuationDistance",
        ]) {
            if (!dielectricSource.includes(marker)) {
                throw new Error(
                    `Upstream glTF dielectric contract changed: ${marker}.`,
                );
            }
        }
        for (const marker of [
            "const minNearest = !!minF && minF % 2 === 0",
            "const mipNearest = minF === 9984 || minF === 9985",
            "const noMip = minF === 9728 || minF === 9729",
            "maxAnisotropy: magLinear && !minNearest && !mipNearest && !noMip ? 4 : 1",
        ]) {
            if (!samplerSource.includes(marker)) {
                throw new Error(
                    `Upstream glTF sampler contract changed: ${marker}.`,
                );
            }
        }
        return {
            modulePath,
            symbolName,
            header: "",
            source: gltfLoaderCpp(this.context.provenance(modulePath, symbolName)),
        };
    }
}
