import ts from "typescript";
import { LoweredSource, LoweringContext } from "./context.js";

interface EnvironmentConstants {
    magic: number[];
    coefficientNames: string[];
    imageType: string;
    harmonicConstants: number[];
}

export class EnvironmentLowerer {
    public constructor(private readonly context: LoweringContext) {}

    public lowerParser(): LoweredSource {
        const modulePath = "src/loader-env/env-parse.ts";
        const symbolName = "parseEnvFile";
        const constants = this.extractConstants();
        if (constants.imageType !== "image/png") {
            throw new Error(`Unsupported pinned environment image type: ${constants.imageType}.`);
        }
        const magic = constants.magic
            .map((value) => `0x${value.toString(16).padStart(2, "0")}`)
            .join(", ");
        const keys = constants.coefficientNames.map((value) => `"${value}"`).join(", ");
        const harmonic = constants.harmonicConstants.map((value) => this.context.floatLiteral(value));
        return {
            modulePath,
            symbolName,
            header: `#pragma once

#include <bblite/runtime.hpp>

#include <array>
#include <cstdint>
#include <vector>

namespace bbl::upstream {

struct ParsedEnvironment {
    std::array<Color3, 9> spherical_harmonics{};
    std::uint32_t width = 0;
    std::uint32_t mip_count = 0;
    std::vector<TextureData> faces;
};

ParsedEnvironment parse_env_file(const std::vector<std::uint8_t>& bytes);

} // namespace bbl::upstream
`,
            source: `// ${this.context.provenance(
                modulePath,
                symbolName,
                "src/loader-env/load-env.ts#polynomialToPreScaledHarmonics",
            )}
#include <bblite/upstream/env_parse.hpp>

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdlib>
#include <stdexcept>
#include <string>
#include <string_view>

namespace bbl::upstream {
namespace {

struct MipmapEntry {
    std::size_t position = 0;
    std::size_t length = 0;
};

void skip_space(std::string_view text, std::size_t& position) {
    while (position < text.size() && std::isspace(static_cast<unsigned char>(text[position]))) ++position;
}

double parse_number(std::string_view text, std::size_t& position) {
    skip_space(text, position);
    const char* begin = text.data() + position;
    char* end = nullptr;
    const double value = std::strtod(begin, &end);
    if (end == begin) throw std::runtime_error("Invalid number in environment manifest.");
    position = static_cast<std::size_t>(end - text.data());
    return value;
}

std::size_t find_value(std::string_view text, std::string_view key, std::size_t start = 0) {
    const std::string quoted = "\\\"" + std::string(key) + "\\\"";
    const std::size_t key_position = text.find(quoted, start);
    if (key_position == std::string_view::npos) {
        throw std::runtime_error("Environment manifest is missing '" + std::string(key) + "'.");
    }
    const std::size_t colon = text.find(':', key_position + quoted.size());
    if (colon == std::string_view::npos) throw std::runtime_error("Invalid environment manifest.");
    return colon + 1;
}

std::size_t parse_unsigned(std::string_view text, std::string_view key, std::size_t start = 0) {
    std::size_t position = find_value(text, key, start);
    const double value = parse_number(text, position);
    if (value < 0.0) throw std::runtime_error("Negative environment manifest value.");
    return static_cast<std::size_t>(value);
}

Color3 parse_color(std::string_view text, std::string_view key, std::size_t start) {
    std::size_t position = text.find('[', find_value(text, key, start));
    if (position == std::string_view::npos) throw std::runtime_error("Invalid environment coefficient.");
    ++position;
    Color3 result;
    result.r = static_cast<float>(parse_number(text, position));
    position = text.find(',', position) + 1;
    result.g = static_cast<float>(parse_number(text, position));
    position = text.find(',', position) + 1;
    result.b = static_cast<float>(parse_number(text, position));
    return result;
}

float channel(const Color3& color, int index) {
    return index == 0 ? color.r : index == 1 ? color.g : color.b;
}

void set_channel(Color3& color, int index, float value) {
    if (index == 0) color.r = value;
    else if (index == 1) color.g = value;
    else color.b = value;
}

std::array<Color3, 9> pre_scale_harmonics(const std::array<Color3, 9>& polynomial) {
    constexpr float c00xy = ${harmonic[0]};
    constexpr float c00z = ${harmonic[1]};
    constexpr float c1 = ${harmonic[2]};
    constexpr float c2 = ${harmonic[3]};
    constexpr float c20zz = ${harmonic[4]};
    constexpr float c20xy = ${harmonic[5]};
    constexpr float c22 = ${harmonic[6]};
    std::array<Color3, 9> result{};
    for (int index = 0; index < 3; ++index) {
        const float x = channel(polynomial[0], index);
        const float y = channel(polynomial[1], index);
        const float z = channel(polynomial[2], index);
        const float xx = channel(polynomial[3], index);
        const float yy = channel(polynomial[4], index);
        const float zz = channel(polynomial[5], index);
        const float yz = channel(polynomial[6], index);
        const float zx = channel(polynomial[7], index);
        const float xy = channel(polynomial[8], index);
        set_channel(result[0], index, (xx + yy) * c00xy + zz * c00z);
        set_channel(result[1], index, y * c1);
        set_channel(result[2], index, z * c1);
        set_channel(result[3], index, x * c1);
        set_channel(result[4], index, xy * c2);
        set_channel(result[5], index, yz * c2);
        set_channel(result[6], index, zz * c20zz - (xx + yy) * c20xy);
        set_channel(result[7], index, zx * c2);
        set_channel(result[8], index, (xx - yy) * c22);
    }
    return result;
}

std::vector<MipmapEntry> parse_mipmaps(std::string_view manifest) {
    const std::size_t start = manifest.find("\\\"mipmaps\\\"");
    const std::size_t array_start = manifest.find('[', start);
    const std::size_t array_end = manifest.find(']', array_start);
    if (start == std::string_view::npos || array_start == std::string_view::npos || array_end == std::string_view::npos) {
        throw std::runtime_error("Invalid environment mipmap array.");
    }
    std::vector<MipmapEntry> result;
    std::size_t cursor = array_start;
    while (true) {
        const std::size_t length_key = manifest.find("\\\"length\\\"", cursor);
        if (length_key == std::string_view::npos || length_key >= array_end) break;
        const std::size_t position_key = manifest.find("\\\"position\\\"", length_key);
        if (position_key == std::string_view::npos || position_key >= array_end) {
            throw std::runtime_error("Invalid environment mipmap entry.");
        }
        result.push_back(MipmapEntry{
            parse_unsigned(manifest, "position", position_key),
            parse_unsigned(manifest, "length", length_key),
        });
        cursor = position_key + 10;
    }
    return result;
}

std::uint32_t mip_level_count(std::uint32_t width) {
    std::uint32_t count = 1;
    while (width > 1) {
        width >>= 1;
        ++count;
    }
    return count;
}

} // namespace

ParsedEnvironment parse_env_file(const std::vector<std::uint8_t>& bytes) {
    static constexpr std::array<std::uint8_t, 8> magic{${magic}};
    if (bytes.size() < magic.size() + 2 || !std::equal(magic.begin(), magic.end(), bytes.begin())) {
        throw std::runtime_error("Invalid .env file: bad magic");
    }
    const auto terminator = std::find(bytes.begin() + 8, bytes.end(), std::uint8_t{0});
    if (terminator == bytes.end()) throw std::runtime_error("Invalid .env manifest.");
    const std::size_t json_end = static_cast<std::size_t>(terminator - bytes.begin());
    const std::size_t binary_start = json_end + 1;
    const std::string_view manifest(
        reinterpret_cast<const char*>(bytes.data() + 8),
        json_end - 8);
    const std::size_t irradiance_start = manifest.find("\\\"irradiance\\\"");
    if (irradiance_start == std::string_view::npos) throw std::runtime_error("Missing irradiance.");
    const std::array<std::string_view, 9> coefficient_names{${keys}};
    std::array<Color3, 9> polynomial{};
    for (std::size_t index = 0; index < coefficient_names.size(); ++index) {
        polynomial[index] = parse_color(manifest, coefficient_names[index], irradiance_start);
    }
    const std::uint32_t width = static_cast<std::uint32_t>(parse_unsigned(manifest, "width"));
    const std::uint32_t mip_count = mip_level_count(width);
    const std::vector<MipmapEntry> mipmaps = parse_mipmaps(manifest);
    if (mipmaps.size() != static_cast<std::size_t>(mip_count) * 6) {
        throw std::runtime_error("Environment mipmap count is not six faces per level.");
    }

    ParsedEnvironment result;
    result.spherical_harmonics = pre_scale_harmonics(polynomial);
    result.width = width;
    result.mip_count = mip_count;
    result.faces.reserve(mipmaps.size());
    for (const MipmapEntry& mipmap : mipmaps) {
        const std::size_t start = binary_start + mipmap.position;
        const std::size_t end = start + mipmap.length;
        if (end > bytes.size()) throw std::runtime_error("Environment mipmap exceeds file.");
        TextureData face;
        face.bytes.assign(
            bytes.begin() + static_cast<std::ptrdiff_t>(start),
            bytes.begin() + static_cast<std::ptrdiff_t>(end));
        result.faces.push_back(std::move(face));
    }
    return result;
}

} // namespace bbl::upstream
`,
        };
    }

    public lowerLoaderAdapter(): LoweredSource {
        const modulePath = "src/loader-env/load-env.ts";
        const symbolName = "loadEnvironment";
        const { file, declaration } =
            this.context.functionDeclaration(
                modulePath,
                symbolName,
            );
        const exposure = this.numericAssignment(
            declaration,
            "scene.imageProcessing.exposure",
            file,
        );
        const contrast = this.numericAssignment(
            declaration,
            "scene.imageProcessing.contrast",
            file,
        );
        return {
            modulePath,
            symbolName,
            header: "",
            source: `// ${this.context.provenance(modulePath, symbolName)}
#include <bblite/pal.hpp>
#include <bblite/runtime.hpp>
#include <bblite/upstream/env_parse.hpp>

#include <algorithm>
#include <cmath>
#include <limits>
#include <stdexcept>
#include <utility>

namespace bbl {

namespace {

std::uint32_t read_u32(const std::vector<std::uint8_t>& bytes, std::size_t offset) {
    if (offset + 4 > bytes.size()) {
        throw std::runtime_error("DDS header is truncated.");
    }
    return
        static_cast<std::uint32_t>(bytes[offset]) |
        (static_cast<std::uint32_t>(bytes[offset + 1]) << 8) |
        (static_cast<std::uint32_t>(bytes[offset + 2]) << 16) |
        (static_cast<std::uint32_t>(bytes[offset + 3]) << 24);
}

} // namespace

void load_environment(Scene& scene, EnvironmentOptions options) {
    upstream::ParsedEnvironment parsed =
        upstream::parse_env_file(pal::read_binary_file(options.environment_url));
    scene.environment.has_irradiance = true;
    scene.environment.spherical_harmonics = parsed.spherical_harmonics;
    scene.environment.specular_width = parsed.width;
    scene.environment.specular_mip_count = parsed.mip_count;
    scene.environment.specular_faces = std::move(parsed.faces);
    scene.environment.specular_rgba16f = false;
    scene.environment.brdf_lut = {};
    if (!options.brdf_url.empty()) {
        scene.environment.brdf_lut.bytes = pal::read_binary_file(options.brdf_url);
    }
    if (!options.ground_texture_url.empty()) {
        scene.environment.ground_texture.bytes =
            pal::read_binary_file(options.ground_texture_url);
        scene.environment.has_ground = true;
    }
    if (!options.skybox_url.empty()) {
        scene.environment.skybox_texture.bytes =
            pal::read_binary_file(options.skybox_url);
        const std::vector<std::uint8_t>& dds = scene.environment.skybox_texture.bytes;
        if (dds.size() < 128 || read_u32(dds, 0) != 0x20534444u) {
            throw std::runtime_error("Background skybox is not a valid DDS file.");
        }
        scene.environment.skybox_width = read_u32(dds, 16);
        scene.environment.skybox_mip_count = std::max(read_u32(dds, 28), 1u);
        scene.environment.skybox_data_offset =
            read_u32(dds, 84) == 808540228u ? 148u : 128u;
        scene.environment.has_skybox = true;
        scene.environment.background_enabled_by_default =
            true;
        scene.environment.skybox_uses_environment = false;
    }
    const float requested_skybox_size =
        options.skybox_size > 0.0f ? options.skybox_size : 20.0f;
    scene.deferred_builders.push_back(
        [&scene, requested_skybox_size]() {
            Vec3 bounds_min{
                std::numeric_limits<float>::infinity(),
                std::numeric_limits<float>::infinity(),
                std::numeric_limits<float>::infinity(),
            };
            Vec3 bounds_max{
                -std::numeric_limits<float>::infinity(),
                -std::numeric_limits<float>::infinity(),
                -std::numeric_limits<float>::infinity(),
            };
            for (const MeshHandle handle : scene.meshes) {
                if (handle.value >= scene.engine->meshes.size()) continue;
                const MeshRecord& mesh =
                    scene.engine->meshes[handle.value];
                if (mesh.geometry >=
                    scene.engine->geometries.size()) {
                    continue;
                }
                const ModelGeometry& geometry =
                    scene.engine->geometries[mesh.geometry];
                bounds_min.x =
                    std::min(bounds_min.x, geometry.bounds_min.x);
                bounds_min.y =
                    std::min(bounds_min.y, geometry.bounds_min.y);
                bounds_min.z =
                    std::min(bounds_min.z, geometry.bounds_min.z);
                bounds_max.x =
                    std::max(bounds_max.x, geometry.bounds_max.x);
                bounds_max.y =
                    std::max(bounds_max.y, geometry.bounds_max.y);
                bounds_max.z =
                    std::max(bounds_max.z, geometry.bounds_max.z);
            }
            scene.environment.ground_size = 15.0f;
            scene.environment.skybox_size =
                requested_skybox_size;
            scene.environment.ground_position = Vec3{};
            scene.environment.skybox_position = Vec3{};
            if (!std::isfinite(bounds_min.x)) return;
            const float dx = bounds_max.x - bounds_min.x;
            const float dy = bounds_max.y - bounds_min.y;
            const float dz = bounds_max.z - bounds_min.z;
            const float diagonal =
                std::sqrt(dx * dx + dy * dy + dz * dz);
            if (diagonal > scene.environment.ground_size) {
                scene.environment.ground_size =
                    diagonal * 2.0f;
                scene.environment.skybox_size =
                    scene.environment.ground_size;
            }
            scene.environment.ground_size *= 1.1f;
            scene.environment.skybox_size *= 1.5f;
            scene.environment.ground_position = Vec3{
                bounds_min.x + dx * 0.5f,
                bounds_min.y - 0.00001f,
                bounds_min.z + dz * 0.5f,
            };
            scene.environment.skybox_position =
                scene.environment.ground_position;
        });
    scene.environment.exposure = ${this.context.floatLiteral(exposure)};
    scene.environment.contrast = ${this.context.floatLiteral(contrast)};
    scene.environment.tone_mapping_enabled = true;
}

} // namespace bbl
`,
        };
    }

    public lowerHdrLoaderAdapter(): LoweredSource {
        const modulePath = "src/loader-hdr/load-hdr.ts";
        const symbolName = "loadHdrEnvironment";
        const { file, declaration } =
            this.context.functionDeclaration(
                modulePath,
                symbolName,
            );
        const exposure = this.numericAssignment(
            declaration,
            "scene.imageProcessing.exposure",
            file,
        );
        const contrast = this.numericAssignment(
            declaration,
            "scene.imageProcessing.contrast",
            file,
        );
        const assemble = this.context.callExpression(
            declaration,
            "assembleEnvironmentTextures",
        );
        const lodExpression = assemble.arguments[3];
        if (!lodExpression) {
            this.context.contractError(
                assemble,
                "Expected HDR LOD generation scale.",
            );
        }
        const lodGenerationScale =
            this.context.numericValue(
                lodExpression,
                file,
            );
        for (const call of [
            "parseRGBE(buffer)",
            "computeSHFromEquirect",
            "equirectToCubemapGPU",
            "prefilterCubemapGPU",
        ]) {
            const callName = call.endsWith("(buffer)")
                ? call.slice(0, -"(buffer)".length)
                : call;
            if (!this.context.hasCall(declaration, callName)) {
                this.context.contractError(
                    declaration,
                    `Expected HDR call '${callName}'.`,
                );
            }
        }
        const toneMapping = this.assignmentExpression(
            declaration,
            "scene.imageProcessing.toneMappingEnabled",
        );
        if (
            toneMapping.right.kind !==
            ts.SyntaxKind.FalseKeyword
        ) {
            this.context.contractError(
                toneMapping.right,
                "Expected HDR tone mapping to be disabled.",
            );
        }
        return {
            modulePath,
            symbolName,
            header: "",
            source: `// ${this.context.provenance(
                modulePath,
                symbolName,
                "src/loader-hdr/hdr-parser.ts#parseRGBE,computeSHFromEquirect and src/loader-hdr/hdr-ibl-pipeline.ts",
            )}
#include <bblite/pal.hpp>
#include <bblite/runtime.hpp>

#include <algorithm>
#include <array>
#include <cstring>
#include <stdexcept>

namespace bbl {
namespace {

std::uint32_t hdr_u32(
    const std::vector<std::uint8_t>& bytes,
    std::size_t offset) {
    if (offset + 4 > bytes.size()) {
        throw std::runtime_error("Compiled HDR package is truncated.");
    }
    return
        static_cast<std::uint32_t>(bytes[offset]) |
        (static_cast<std::uint32_t>(bytes[offset + 1]) << 8) |
        (static_cast<std::uint32_t>(bytes[offset + 2]) << 16) |
        (static_cast<std::uint32_t>(bytes[offset + 3]) << 24);
}

float hdr_f32(
    const std::vector<std::uint8_t>& bytes,
    std::size_t offset) {
    const std::uint32_t bits = hdr_u32(bytes, offset);
    float result = 0.0f;
    static_assert(sizeof(result) == sizeof(bits));
    std::memcpy(&result, &bits, sizeof(result));
    return result;
}

} // namespace

void load_hdr_environment(
    Scene& scene,
    HdrEnvironmentOptions options) {
    const std::vector<std::uint8_t> bytes =
        pal::read_binary_file(options.environment_url);
    static constexpr std::array<std::uint8_t, 8> magic{
        0x42, 0x42, 0x4c, 0x48, 0x44, 0x52, 0x31, 0x00};
    if (
        bytes.size() < 124 ||
        !std::equal(magic.begin(), magic.end(), bytes.begin())) {
        throw std::runtime_error("Invalid compiled HDR environment package.");
    }
    const std::uint32_t width = hdr_u32(bytes, 8);
    const std::uint32_t mip_count = hdr_u32(bytes, 12);
    if (width == 0 || mip_count == 0) {
        throw std::runtime_error("Compiled HDR environment has invalid dimensions.");
    }

    scene.environment.has_irradiance = true;
    for (std::size_t coefficient = 0; coefficient < 9; ++coefficient) {
        scene.environment.spherical_harmonics[coefficient] = Color3{
            hdr_f32(bytes, 16 + coefficient * 12),
            hdr_f32(bytes, 20 + coefficient * 12),
            hdr_f32(bytes, 24 + coefficient * 12),
        };
    }
    scene.environment.specular_width = width;
    scene.environment.specular_mip_count = mip_count;
    scene.environment.specular_rgba16f = true;
    scene.environment.specular_faces.clear();
    scene.environment.specular_faces.reserve(
        static_cast<std::size_t>(mip_count) * 6);
    std::size_t offset = 124;
    for (std::uint32_t mip = 0; mip < mip_count; ++mip) {
        const std::uint32_t size = std::max(width >> mip, 1u);
        const std::size_t byte_size =
            static_cast<std::size_t>(size) * size * 8;
        for (std::uint32_t face = 0; face < 6; ++face) {
            if (offset + byte_size > bytes.size()) {
                throw std::runtime_error(
                    "Compiled HDR environment pixel data is truncated.");
            }
            TextureData data;
            data.bytes.assign(
                bytes.begin() + static_cast<std::ptrdiff_t>(offset),
                bytes.begin() +
                    static_cast<std::ptrdiff_t>(offset + byte_size));
            scene.environment.specular_faces.push_back(std::move(data));
            offset += byte_size;
        }
    }
    if (offset != bytes.size()) {
        throw std::runtime_error(
            "Compiled HDR environment has trailing pixel data.");
    }

    scene.environment.brdf_lut = {};
    if (!options.brdf_url.empty()) {
        scene.environment.brdf_lut.bytes =
            pal::read_binary_file(options.brdf_url);
        scene.environment.brdf_lut_width = 256;
        scene.environment.brdf_lut_rgba16f = true;
    }
    scene.environment.has_ground = false;
    scene.environment.has_skybox = options.use_cubemap_skybox;
    scene.environment.background_enabled_by_default =
        options.use_cubemap_skybox;
    scene.environment.skybox_uses_environment =
        options.use_cubemap_skybox;
    scene.environment.skybox_size = options.skybox_size;
    scene.environment.skybox_position = options.skybox_position;
    scene.environment.exposure = ${this.context.floatLiteral(exposure)};
    scene.environment.contrast = ${this.context.floatLiteral(contrast)};
    scene.environment.lod_generation_scale =
        ${this.context.floatLiteral(lodGenerationScale)};
    scene.environment.tone_mapping_enabled = false;
}

} // namespace bbl
`,
        };
    }

    private extractConstants(): EnvironmentConstants {
        const parserModule = "src/loader-env/env-parse.ts";
        const loaderModule = "src/loader-env/load-env.ts";
        const parser = this.context.sourceFile(parserModule);
        const loader = this.context.sourceFile(loaderModule);
        const magicExpression =
            this.context.unwrapExpression(
                this.context.variableInitializer(
                    parser,
                    "ENV_MAGIC",
                ),
            );
        if (
            !ts.isNewExpression(magicExpression) ||
            !ts.isIdentifier(magicExpression.expression) ||
            magicExpression.expression.text !== "U8" ||
            magicExpression.arguments?.length !== 1 ||
            !ts.isArrayLiteralExpression(
                magicExpression.arguments[0]!,
            )
        ) {
            this.context.contractError(
                magicExpression,
                "Expected ENV_MAGIC byte array.",
            );
        }
        const magic =
            magicExpression.arguments[0].elements.map(
                (element) =>
                    this.context.numericValue(
                        element,
                        parser,
                    ),
            );
        const keysExpression =
            this.context.unwrapExpression(
                this.context.variableInitializer(
                    parser,
                    "shKeys",
                ),
            );
        if (!ts.isArrayLiteralExpression(keysExpression)) {
            this.context.contractError(
                keysExpression,
                "Expected spherical-harmonic key array.",
            );
        }
        const coefficientNames =
            keysExpression.elements.map((element) =>
                this.context.stringValue(element, parser),
            );
        const imageType = this.context.findNodes(
            parser,
            (node): node is ts.BinaryExpression =>
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind ===
                    ts.SyntaxKind.BarBarToken &&
                this.context
                    .propertyPath(node.left)
                    ?.join(".") ===
                    "manifest.imageType" &&
                ts.isStringLiteral(node.right),
        )[0];
        if (!imageType || !ts.isStringLiteral(imageType.right)) {
            this.context.contractError(
                parser,
                "Expected environment image-type fallback.",
            );
        }
        const constant = (name: string): number =>
            this.context.numericValue(
                this.context.variableInitializer(
                    loader,
                    name,
                ),
                loader,
            );
        return {
            magic,
            coefficientNames,
            imageType: imageType.right.text,
            harmonicConstants: [
                constant("C00xy"),
                constant("C00z"),
                constant("C1"),
                constant("C2"),
                constant("C20zz"),
                constant("C20xy"),
                constant("C22"),
            ],
        };
    }

    private assignmentExpression(
        declaration: ts.FunctionDeclaration,
        path: string,
    ): ts.BinaryExpression {
        const expression = this.context.findNodes(
            declaration,
            (node): node is ts.BinaryExpression =>
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind ===
                    ts.SyntaxKind.EqualsToken &&
                this.context
                    .propertyPath(node.left)
                    ?.join(".") === path,
        )[0];
        if (!expression) {
            this.context.contractError(
                declaration,
                `Expected assignment to '${path}'.`,
            );
        }
        return expression;
    }

    private numericAssignment(
        declaration: ts.FunctionDeclaration,
        path: string,
        file: ts.SourceFile,
    ): number {
        return this.context.numericValue(
            this.assignmentExpression(declaration, path).right,
            file,
        );
    }
}
