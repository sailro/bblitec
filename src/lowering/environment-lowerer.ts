import ts from "typescript";
import { LoweredSource, LoweringContext } from "./context.js";
import {
    COLOR_CHANNEL_HELPERS_CPP,
    lowerShPrescaleCpp,
} from "./gltf-lowerer.js";

/** The DDS background composite, reached without the `.env` loader. */
const DDS_BACKGROUND_MODULE =
    "src/material/pbr/background-dds-environment.ts";

interface EnvironmentConstants {
    magic: number[];
    coefficientNames: string[];
    imageType: string;
}

export class EnvironmentLowerer {
    public constructor(private readonly context: LoweringContext) {}

    public lowerImageSkyboxAdapter(): LoweredSource {
        const modulePath = "src/loader-skybox/load-skybox.ts";
        const symbolName = "loadSkybox";
        const { file, declaration } =
            this.context.functionDeclaration(
                modulePath,
                symbolName,
            );
        const sizeParameter = declaration.parameters[3];
        if (
            !sizeParameter?.initializer ||
            this.context.numericValue(
                sizeParameter.initializer,
                file,
            ) !== 100
        ) {
            this.context.contractError(
                sizeParameter ?? declaration,
                "Expected the pinned loadSkybox size default of 100.",
            );
        }
        for (const called of [
            "loadCubeTexture",
            "createBoxData",
            "buildSkyboxRenderable",
        ]) {
            if (!this.context.hasCall(declaration, called)) {
                this.context.contractError(
                    declaration,
                    `Expected loadSkybox to call ${called}.`,
                );
            }
        }
        const cubeModulePath = "src/texture/cube-texture.ts";
        const { declaration: loadCubeTexture } =
            this.context.functionDeclaration(
                cubeModulePath,
                "loadCubeTexture",
            );
        const faceSuffixes = [
            "_px",
            "_nx",
            "_py",
            "_ny",
            "_pz",
            "_nz",
        ];
        if (
            !this.context.hasNode(
                loadCubeTexture,
                (node) =>
                    ts.isArrayLiteralExpression(node) &&
                    node.elements.length ===
                        faceSuffixes.length &&
                    node.elements.every(
                        (element, index) =>
                            ts.isStringLiteral(element) &&
                            element.text ===
                                faceSuffixes[index],
                    ),
            )
        ) {
            this.context.contractError(
                loadCubeTexture,
                "Expected the pinned cube face suffix order.",
            );
        }
        if (
            !this.context.hasNode(
                loadCubeTexture,
                (node) =>
                    ts.isPropertyAssignment(node) &&
                    ts.isIdentifier(node.name) &&
                    node.name.text === "format" &&
                    ts.isStringLiteral(node.initializer) &&
                    node.initializer.text === "rgba8unorm",
            )
        ) {
            this.context.contractError(
                loadCubeTexture,
                "Expected the pinned rgba8unorm cube format.",
            );
        }
        if (
            !this.context.hasCall(
                loadCubeTexture,
                "mipLevelCount",
            )
        ) {
            this.context.contractError(
                loadCubeTexture,
                "Expected the pinned full cube mip chain.",
            );
        }
        return {
            modulePath,
            symbolName,
            header: "",
            source: `// ${this.context.provenance(modulePath, symbolName, "src/texture/cube-texture.ts#loadCubeTexture")}
#include <bblite/pal.hpp>
#include <bblite/runtime.hpp>

namespace bbl {

void load_image_skybox(
    Scene& scene,
    std::array<std::string, 6> face_paths,
    float size) {
    for (std::size_t face = 0; face < face_paths.size(); ++face) {
        scene.environment.image_skybox_faces[face].bytes =
            pal::read_binary_file(face_paths[face]);
    }
    scene.environment.image_skybox_size = size;
    scene.environment.has_image_skybox = true;
    scene.environment.background_enabled_by_default = true;
}

} // namespace bbl
`,
        };
    }

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
        // The same emission the glTF loader carries, from the same pair of
        // pinned copies with the same divergence cross-check — one
        // pre_scale_harmonics for both loaders instead of a transcription
        // beside a lowering.
        const prescale = lowerShPrescaleCpp(
            this.context.sourceFile("src/loader-gltf/ibl-env-assembly.ts"),
            this.context.sourceFile("src/loader-env/load-env.ts"),
        );
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

${COLOR_CHANNEL_HELPERS_CPP}

${prescale}

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

    /**
     * The `.env` loader and the DDS background composite, in one unit.
     *
     * They are two entry points into the same pair of pinned builders --
     * `buildGroundRenderable` and `buildDdsSkyboxRenderable` -- and they
     * share every derivation the port needs to reach them: the world-bounds
     * walk, `computeSceneSize`, and the DDS header the skybox plan reads.
     * Emitting them apart would state each of those twice, so which
     * functions this unit carries follows the features the scene reached
     * rather than the file boundary upstream draws between the two modules.
     */
    public lowerLoaderAdapter(options: {
        loadEnvironment: boolean;
        ddsBackground: boolean;
    }): LoweredSource {
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
        // Which background renderables the deferred builder pushes is the
        // contract the compiler decides from the two URLs and the two skip
        // flags, so assert the pin still composes it that way.
        for (const called of [
            "buildSolidSkyboxRenderable",
            "buildGroundRenderable",
            "buildDdsSkyboxRenderable",
            "buildHdrSkyboxRenderable",
            "computeSceneSize",
        ]) {
            if (!this.context.hasCall(declaration, called)) {
                this.context.contractError(
                    declaration,
                    `Expected loadEnvironment to call ${called}.`,
                );
            }
        }
        const sceneSize = this.readSceneSizeContract();
        if (
            !this.context.hasNode(
                declaration,
                (node) =>
                    ts.isPropertyAssignment(node) &&
                    ts.isIdentifier(node.name) &&
                    node.name.text === "skipSkybox" &&
                    /^skyboxIsDds \|\| skyboxIsEnv \|\| options\?\.skipSkybox$/.test(
                        node.initializer.getText(file).trim(),
                    ),
            )
        ) {
            this.context.contractError(
                declaration,
                "Expected the pinned solid-skybox condition (skyboxIsDds || skyboxIsEnv || skipSkybox).",
            );
        }
        const background = options.ddsBackground
            ? this.readDdsBackgroundContract()
            : undefined;
        return {
            modulePath,
            symbolName: [
                options.loadEnvironment ? symbolName : undefined,
                background ? "addDdsEnvironmentBackground" : undefined,
            ]
                .filter((name): name is string => name !== undefined)
                .join(","),
            header: "",
            source: `// ${this.context.provenance(
                modulePath,
                symbolName,
                background
                    ? `${DDS_BACKGROUND_MODULE}#addDdsEnvironmentBackground`
                    : undefined,
            )}
#include <bblite/pal.hpp>
#include <bblite/runtime.hpp>
${options.loadEnvironment ? "#include <bblite/upstream/env_parse.hpp>\n" : ""}#include <bblite/upstream/renderer_plan.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <stdexcept>
#include <utility>

namespace bbl {

namespace {

// src/mesh/mesh-world-bounds.ts expandWorldAabbForMesh. Bounds remain local
// and the pin takes them through the mesh's live float32 world matrix before
// sizing the deferred environment. Keeping that transform is essential for
// procedural meshes added after loadEnvironment (including invisible shadow
// anchors), and the centre/abs-coefficient-radius arithmetic stays in the
// JavaScript-number width the pin evaluates it at.
void expand_world_aabb_for_box(
    std::array<double, 3>& minimum,
    std::array<double, 3>& maximum,
    const Vec3& box_min,
    const Vec3& box_max,
    const std::array<float, 16>& world) {
    const std::array<double, 3> low{box_min.x, box_min.y, box_min.z};
    const std::array<double, 3> high{box_max.x, box_max.y, box_max.z};
    std::array<double, 3> center{};
    std::array<double, 3> extent{};
    for (int axis = 0; axis < 3; ++axis) {
        center[axis] = (low[axis] + high[axis]) * 0.5;
        extent[axis] = (high[axis] - low[axis]) * 0.5;
    }
    for (int row = 0; row < 3; ++row) {
        double transformed_center = world[12 + row];
        double transformed_radius = 0.0;
        for (int column = 0; column < 3; ++column) {
            const double coefficient = world[column * 4 + row];
            transformed_center += coefficient * center[column];
            transformed_radius +=
                std::abs(coefficient) * extent[column];
        }
        minimum[row] = std::min(
            minimum[row],
            transformed_center - transformed_radius);
        maximum[row] = std::max(
            maximum[row],
            transformed_center + transformed_radius);
    }
}

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

// The DDS cube a background skybox draws from, as both entry points read
// it: src/material/pbr/background-dds-skybox.ts uploads the container's own
// mip chain, so what the record keeps is the header that upload walks.
void read_dds_skybox(
    EnvironmentState& environment,
    const std::string& skybox_url) {
    environment.skybox_texture.bytes =
        pal::read_binary_file(skybox_url);
    const std::vector<std::uint8_t>& dds = environment.skybox_texture.bytes;
    if (dds.size() < 128 || read_u32(dds, 0) != 0x20534444u) {
        throw std::runtime_error("Background skybox is not a valid DDS file.");
    }
    environment.skybox_width = read_u32(dds, 16);
    environment.skybox_mip_count = std::max(read_u32(dds, 28), 1u);
    environment.skybox_data_offset =
        read_u32(dds, 84) == 808540228u ? 148u : 128u;
    environment.has_skybox = true;
    environment.background_enabled_by_default = true;
    environment.skybox_uses_environment = false;
}

// src/material/pbr/scene-size.ts computeSceneSize over
// src/mesh/mesh-world-bounds.ts expandWorldAabbForMesh. Both run
// in JavaScript doubles over Float32Array boxes, and the box is
// re-derived as a centre plus a per-row abs-coefficient radius
// rather than taken as min/max -- which returns the same bounds
// through an identity world matrix only because every term of
// that round-trip is exact in double. Accumulating in float
// instead moved the root by one ULP, and the background dither
// seeds on the world position it places, so the whole ground
// decorrelated.
//
// Every caller runs it from a deferred builder because upstream computes it
// inside one: the bounds are the scene's at build time, not at load time.
void apply_scene_size(Scene& scene, double requested_skybox_size) {
    std::array<double, 3> bounds_min{
        std::numeric_limits<double>::infinity(),
        std::numeric_limits<double>::infinity(),
        std::numeric_limits<double>::infinity(),
    };
    std::array<double, 3> bounds_max{
        -std::numeric_limits<double>::infinity(),
        -std::numeric_limits<double>::infinity(),
        -std::numeric_limits<double>::infinity(),
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
        const std::array<float, 16> world =
            upstream::mesh_world_matrix(*scene.engine, mesh);
        expand_world_aabb_for_box(
            bounds_min,
            bounds_max,
            geometry.bounds_min,
            geometry.bounds_max,
            world);
    }
    scene.environment.ground_size = ${this.context.floatLiteral(sceneSize.groundDefault)};
    scene.environment.skybox_size =
        static_cast<float>(requested_skybox_size);
    scene.environment.ground_position = Vec3{};
    scene.environment.skybox_position = Vec3{};
    if (!std::isfinite(bounds_min[0])) return;
    const double dx = bounds_max[0] - bounds_min[0];
    const double dy = bounds_max[1] - bounds_min[1];
    const double dz = bounds_max[2] - bounds_min[2];
    const double diagonal =
        std::sqrt(dx * dx + dy * dy + dz * dz);
    double ground_size = ${this.context.doubleLiteral(sceneSize.groundDefault)};
    double skybox_size = requested_skybox_size;
    if (
        scene.camera.value < scene.engine->cameras.size() &&
        scene.engine->cameras[scene.camera.value].kind ==
            CameraKind::arc_rotate) {
        const CameraRecord& camera =
            scene.engine->cameras[scene.camera.value];
        if (
            camera.upper_radius_limit &&
            *camera.upper_radius_limit != 0.0) {
            ground_size = *camera.upper_radius_limit *
                ${this.context.doubleLiteral(sceneSize.cameraRadiusScale)};
            skybox_size = ground_size;
        }
    }
    if (diagonal > ground_size) {
        ground_size = diagonal * ${this.context.doubleLiteral(sceneSize.diagonalScale)};
        skybox_size = ground_size;
    }
    ground_size *= ${this.context.doubleLiteral(sceneSize.groundScale)};
    skybox_size *= ${this.context.doubleLiteral(sceneSize.skyboxScale)};
    scene.environment.ground_size =
        static_cast<float>(ground_size);
    scene.environment.skybox_size =
        static_cast<float>(skybox_size);
    scene.environment.ground_position = Vec3{
        static_cast<float>(bounds_min[0] + dx * ${this.context.doubleLiteral(sceneSize.rootHalf)}),
        static_cast<float>(bounds_min[1] - ${this.context.doubleLiteral(sceneSize.rootDrop)}),
        static_cast<float>(bounds_min[2] + dz * ${this.context.doubleLiteral(sceneSize.rootHalf)}),
    };
    scene.environment.skybox_position =
        scene.environment.ground_position;
}

} // namespace
${
    background
        ? `
// ${this.context.provenance(
              DDS_BACKGROUND_MODULE,
              "addDdsEnvironmentBackground",
          )}
//
// Both renderables are unconditional here because the pinned module pushes
// both from its one deferred builder and takes no skip flags. Its
// \`${background.sceneSizeCall}\` is the sizing the .env loader's own builder
// runs, so both entry points share it, and \`enableNoise\` selects between the
// two generated fragment variants exactly as the pin's pipeline-cache key
// does.
void add_dds_environment_background(
    Scene& scene,
    DdsEnvironmentBackgroundOptions options) {
    scene.environment.ground_texture.bytes =
        pal::read_binary_file(options.ground_texture_url);
    scene.environment.has_ground = true;
    read_dds_skybox(scene.environment, options.skybox_url);
    scene.environment.enable_noise = options.enable_noise;
    const float requested_skybox_size = options.skybox_size;
    scene.deferred_builders.push_back(
        [&scene, requested_skybox_size]() {
            apply_scene_size(
                scene,
                static_cast<double>(requested_skybox_size));
        });
}
`
        : ""
}${options.loadEnvironment ? `
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
    }
    // buildGroundRenderable takes the texture URL as optional and uploads a
    // 1x1 white texel when it has none, so the ground follows skipGround
    // alone; the PAL already carries that same white fallback.
    scene.environment.has_ground = options.ground;
    // src/loader-env/load-env.ts, the !bgOptions.skipSkybox arm: the cube is
    // pushed before the DDS and .env arms and is the only background this
    // scene reaches when neither of those applies.
    scene.environment.has_solid_skybox = options.solid_skybox;
    if (options.solid_skybox) {
        scene.environment.background_enabled_by_default = true;
    }
    if (options.skybox_uses_environment) {
        // src/loader-env/load-env.ts, the skyboxIsEnv branch: the skybox is
        // the environment's own cubemap, drawn through the same renderable
        // the HDR path builds, so nothing further is loaded.
        scene.environment.has_skybox = true;
        scene.environment.background_enabled_by_default = true;
        scene.environment.skybox_uses_environment = true;
    } else if (!options.skybox_url.empty()) {
        read_dds_skybox(scene.environment, options.skybox_url);
    }
    const float requested_skybox_size =
        options.skybox_size > 0.0f ? options.skybox_size : ${this.context.floatLiteral(sceneSize.skyboxDefault)};
    scene.deferred_builders.push_back(
        [&scene, requested_skybox_size]() {
            apply_scene_size(
                scene,
                static_cast<double>(requested_skybox_size));
        });
    scene.environment.exposure = ${this.context.floatLiteral(exposure)};
    scene.environment.contrast = ${this.context.floatLiteral(contrast)};
    scene.environment.tone_mapping_enabled = true;
}
` : ""}
} // namespace bbl
`,
        };
    }

    /**
     * The pinned DDS background composite's own shape, before it is emitted.
     *
     * `addDdsEnvironmentBackground` is a composite rather than a builder: it
     * calls `computeSceneSize` and pushes the same two renderables the `.env`
     * loader's builder pushes, with `enableNoise` threaded into both. Each of
     * those is a claim about the pin that the emitted body depends on, so
     * each is checked here rather than assumed.
     */
    private readDdsBackgroundContract(): { sceneSizeCall: string } {
        const { file, declaration } =
            this.context.functionDeclaration(
                DDS_BACKGROUND_MODULE,
                "addDdsEnvironmentBackground",
            );
        for (const called of [
            "computeSceneSize",
            "buildDdsSkyboxRenderable",
            "buildGroundRenderable",
        ]) {
            if (!this.context.hasCall(declaration, called)) {
                this.context.contractError(
                    declaration,
                    `Expected addDdsEnvironmentBackground to call ${called}.`,
                );
            }
        }
        // Both renderables take the flag, so a port that dropped it from
        // either would dither half a background. `?? true` is the pin's own
        // default and is what makes the `.env` loader's noise-on arm the
        // same value this one carries when the scene omits it.
        if (
            !this.context.hasNode(
                declaration,
                (node) =>
                    ts.isVariableDeclaration(node) &&
                    ts.isIdentifier(node.name) &&
                    node.name.text === "enableNoise" &&
                    node.initializer?.getText(file).trim() ===
                        "options.enableNoise ?? true",
            )
        ) {
            this.context.contractError(
                declaration,
                "Expected the pinned enableNoise default (options.enableNoise ?? true).",
            );
        }
        for (const builder of [
            "buildDdsSkyboxRenderable",
            "buildGroundRenderable",
        ]) {
            const call = this.context.callExpression(declaration, builder);
            const last = call.arguments[call.arguments.length - 1];
            if (last?.getText(file).trim() !== "enableNoise") {
                this.context.contractError(
                    call,
                    `Expected ${builder} to take enableNoise last.`,
                );
            }
        }
        const sceneSize = this.context.callExpression(
            declaration,
            "computeSceneSize",
        );
        return { sceneSizeCall: sceneSize.getText(file).replace(/\s+/g, " ") };
    }

    public lowerDdsLoaderAdapter(): LoweredSource {
        const modulePath = "src/loader-env/load-dds-env.ts";
        const symbolName = "loadDdsEnvironment";
        const { file, declaration } =
            this.context.functionDeclaration(
                modulePath,
                symbolName,
            );
        const assemble = this.context.callExpression(
            declaration,
            "assembleEnvironmentTextures",
        );
        const lodExpression = assemble.arguments[3];
        if (!lodExpression) {
            this.context.contractError(
                assemble,
                "Expected DDS LOD generation scale.",
            );
        }
        const lodGenerationScale = this.context.numericValue(
            lodExpression,
            file,
        );
        // The pin is explicit that this loader leaves image processing to the
        // caller, unlike the .env loader beside it, and says why: BJS's
        // CreateFromPrefilteredData does not touch it either. If that ever
        // changes the native record has to follow, so assert it rather than
        // assume it.
        if (
            this.context.hasNode(declaration, (node) =>
                ts.isPropertyAccessExpression(node) &&
                this.context
                    .propertyPath(node)
                    ?.join(".")
                    .startsWith("scene.imageProcessing") === true,
            )
        ) {
            this.context.contractError(
                declaration,
                "Pinned DDS environment loader now writes image processing state.",
            );
        }
        for (const call of ["computeSH", "assembleEnvironmentTextures"]) {
            if (!this.context.hasCall(declaration, call)) {
                this.context.contractError(
                    declaration,
                    `Expected DDS call '${call}'.`,
                );
            }
        }
        return {
            modulePath,
            symbolName,
            header: "",
            source: `// ${this.context.provenance(
                modulePath,
                symbolName,
                "src/loader-env/load-dds-env.ts#computeSH is compiled into the package by src/dds-packager.ts",
            )}
#include <bblite/pal.hpp>
#include <bblite/runtime.hpp>

#include <algorithm>
#include <array>
#include <cstring>
#include <stdexcept>

namespace bbl {
namespace {

std::uint32_t package_u32(
    const std::vector<std::uint8_t>& bytes,
    std::size_t offset) {
    if (offset + 4 > bytes.size()) {
        throw std::runtime_error("Compiled DDS package is truncated.");
    }
    return
        static_cast<std::uint32_t>(bytes[offset]) |
        (static_cast<std::uint32_t>(bytes[offset + 1]) << 8) |
        (static_cast<std::uint32_t>(bytes[offset + 2]) << 16) |
        (static_cast<std::uint32_t>(bytes[offset + 3]) << 24);
}

float package_f32(
    const std::vector<std::uint8_t>& bytes,
    std::size_t offset) {
    const std::uint32_t bits = package_u32(bytes, offset);
    float result = 0.0f;
    static_assert(sizeof(result) == sizeof(bits));
    std::memcpy(&result, &bits, sizeof(result));
    return result;
}

} // namespace

void load_dds_environment(
    Scene& scene,
    DdsEnvironmentOptions options) {
    const std::vector<std::uint8_t> bytes =
        pal::read_binary_file(options.environment_url);
    static constexpr std::array<std::uint8_t, 8> magic{
        0x42, 0x42, 0x4c, 0x48, 0x44, 0x52, 0x31, 0x00};
    if (
        bytes.size() < 124 ||
        !std::equal(magic.begin(), magic.end(), bytes.begin())) {
        throw std::runtime_error("Invalid compiled DDS environment package.");
    }
    const std::uint32_t width = package_u32(bytes, 8);
    const std::uint32_t mip_count = package_u32(bytes, 12);
    if (width == 0 || mip_count == 0) {
        throw std::runtime_error("Compiled DDS environment has invalid dimensions.");
    }
    scene.environment.has_irradiance = true;
    for (std::size_t coefficient = 0; coefficient < 9; ++coefficient) {
        scene.environment.spherical_harmonics[coefficient] = Color3{
            package_f32(bytes, 16 + coefficient * 12),
            package_f32(bytes, 20 + coefficient * 12),
            package_f32(bytes, 24 + coefficient * 12),
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
                    "Compiled DDS environment pixel data is truncated.");
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
            "Compiled DDS environment has trailing pixel data.");
    }
    // The pinned loader decodes the same bundled BRDF PNG the .env loader
    // does (loadBrdfImage then decodeBrdfPng), rather than generating the LUT
    // with a compute pass the way the HDR loader beside it does.
    scene.environment.brdf_lut = {};
    if (!options.brdf_url.empty()) {
        scene.environment.brdf_lut.bytes =
            pal::read_binary_file(options.brdf_url);
    }
    // A DDS environment creates no background of its own: the pinned loader
    // takes a cubemap and nothing else.
    scene.environment.has_ground = false;
    scene.environment.has_skybox = false;
    scene.environment.background_enabled_by_default = false;
    scene.environment.lod_generation_scale =
        ${this.context.floatLiteral(lodGenerationScale)};
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

    /**
     * The sizing the deferred builder reproduces. Round 1 pinned its
     * numbers as an order-free literal bag; here each constant is read
     * from its own parameter position — the empty-scene defaults, the
     * diagonal override, the two final scales, and the root composition —
     * and FLOWS into the emitted builder, so a moved literal cannot pass
     * by matching a different parameter that happens to share its value.
     */
    private readSceneSizeContract(): {
        groundDefault: number;
        skyboxDefault: number;
        cameraRadiusScale: number;
        diagonalScale: number;
        groundScale: number;
        skyboxScale: number;
        rootHalf: number;
        rootDrop: number;
    } {
        const sizeModule = "src/material/pbr/scene-size.ts";
        const boundsModule = "src/mesh/mesh-world-bounds.ts";
        const { file, declaration } =
            this.context.functionDeclaration(
                sizeModule,
                "computeSceneSize",
            );
        for (const call of [
            "emptyWorldAabb",
            "expandWorldAabbForMesh",
        ]) {
            if (!this.context.hasCall(declaration, call)) {
                this.context.contractError(
                    declaration,
                    `Expected computeSceneSize to call ${call}.`,
                );
            }
        }
        // The empty-scene early return (the first object-literal return)
        // and the main path's seeds must agree: the emitted builder stores
        // the defaults once, before the finite check, and returns.
        const emptyReturn = this.context.returnObject(declaration);
        const emptyGround = this.context.numericValue(
            this.context.propertyInitializer(
                emptyReturn,
                "groundSize",
            ),
            file,
        );
        const skyboxFallback = (
            expression: ts.Expression,
            label: string,
        ): number => {
            const unwrapped =
                this.context.unwrapExpression(expression);
            if (
                !ts.isBinaryExpression(unwrapped) ||
                unwrapped.operatorToken.kind !==
                    ts.SyntaxKind.QuestionQuestionToken ||
                !ts.isIdentifier(unwrapped.left) ||
                unwrapped.left.text !== "userSkyboxSize"
            ) {
                this.context.contractError(
                    expression,
                    `Expected ${label} to default the user skybox size.`,
                );
            }
            return this.context.numericValue(
                unwrapped.right,
                file,
            );
        };
        const emptySkybox = skyboxFallback(
            this.context.propertyInitializer(
                emptyReturn,
                "skyboxSize",
            ),
            "the empty-scene skybox size",
        );
        const emptyRoot = this.context.numericTuple(
            this.context.propertyInitializer(
                emptyReturn,
                "rootPosition",
            ),
            file,
        );
        if (emptyRoot.some((component) => component !== 0)) {
            this.context.contractError(
                emptyReturn,
                "Expected the empty-scene root at the origin.",
            );
        }
        const groundDefault = this.context.numericValue(
            this.context.variableInitializer(
                declaration,
                "groundSize",
            ),
            file,
        );
        const skyboxDefault = skyboxFallback(
            this.context.variableInitializer(
                declaration,
                "skyboxSize",
            ),
            "the skybox seed",
        );
        if (
            groundDefault !== emptyGround ||
            skyboxDefault !== emptySkybox
        ) {
            this.context.contractError(
                declaration,
                "Scene-size defaults no longer agree between the empty and sized paths.",
            );
        }
        // The camera-limit and diagonal override arms, paired with the
        // emitted deferred builder line by line. The camera's
        // upperRadiusLimit wins first, exactly as in the pin; the diagonal
        // may then widen it. Select each arm by its multiplicand rather than
        // by position so a harmless source reorder does not confuse them.
        for (const [name, expected] of [
            ["dx", "maxX - minX"],
            ["dy", "maxY - minY"],
            ["dz", "maxZ - minZ"],
            [
                "sceneDiagonalLength",
                "Math.sqrt(dx * dx + dy * dy + dz * dz)",
            ],
        ] as const) {
            this.context.assertExpressionShape(
                this.context.variableInitializer(
                    declaration,
                    name,
                ),
                expected,
                `Scene-size '${name}'`,
            );
        }
        const assignments = this.context.findNodes(
            declaration,
            (node): node is ts.BinaryExpression =>
                ts.isBinaryExpression(node),
        );
        const cam = this.context.unwrapExpression(
            this.context.variableInitializer(
                declaration,
                "cam",
            ),
        );
        if (
            !ts.isPropertyAccessExpression(cam) ||
            !ts.isIdentifier(cam.expression) ||
            cam.expression.text !== "scene" ||
            cam.name.text !== "camera"
        ) {
            this.context.contractError(
                cam,
                "Expected scene sizing to inspect scene.camera.",
            );
        }
        const cameraGuards = assignments.filter(
            (expression) =>
                expression.operatorToken.kind ===
                    ts.SyntaxKind.InKeyword &&
                ts.isStringLiteral(expression.left) &&
                expression.left.text === "upperRadiusLimit" &&
                ts.isIdentifier(expression.right) &&
                expression.right.text === "cam",
        );
        if (cameraGuards.length !== 1) {
            this.context.contractError(
                declaration,
                "Expected one arc-rotate upperRadiusLimit guard.",
            );
        }
        const cameraOverrides = assignments.filter(
            (expression) => {
                if (
                    expression.operatorToken.kind !==
                        ts.SyntaxKind.EqualsToken ||
                    !ts.isIdentifier(expression.left) ||
                    expression.left.text !== "groundSize"
                ) {
                    return false;
                }
                const product = this.context.unwrapExpression(
                    expression.right,
                );
                if (
                    !ts.isBinaryExpression(product) ||
                    product.operatorToken.kind !==
                        ts.SyntaxKind.AsteriskToken ||
                    !ts.isNumericLiteral(product.right)
                ) {
                    return false;
                }
                const limit = this.context.unwrapExpression(
                    product.left,
                );
                return (
                    ts.isPropertyAccessExpression(limit) &&
                    limit.name.text === "upperRadiusLimit" &&
                    ts.isIdentifier(
                        this.context.unwrapExpression(
                            limit.expression,
                        ),
                    ) &&
                    (
                        this.context.unwrapExpression(
                            limit.expression,
                        ) as ts.Identifier
                    ).text === "cam"
                );
            },
        );
        if (cameraOverrides.length !== 1) {
            this.context.contractError(
                declaration,
                "Expected one camera-radius-driven ground override.",
            );
        }
        const cameraRadiusScale = this.context.numericValue(
            (
                this.context.unwrapExpression(
                    cameraOverrides[0]!.right,
                ) as ts.BinaryExpression
            ).right,
            file,
        );
        const diagonalGuards = assignments.filter(
            (expression) =>
                expression.operatorToken.kind ===
                    ts.SyntaxKind.GreaterThanToken &&
                ts.isIdentifier(expression.left) &&
                expression.left.text ===
                    "sceneDiagonalLength" &&
                ts.isIdentifier(expression.right) &&
                expression.right.text === "groundSize",
        );
        if (diagonalGuards.length !== 1) {
            this.context.contractError(
                declaration,
                "Expected one diagonal-versus-ground guard.",
            );
        }
        const diagonalOverrides = assignments.filter(
            (expression) => {
                if (
                    expression.operatorToken.kind !==
                        ts.SyntaxKind.EqualsToken ||
                    !ts.isIdentifier(expression.left) ||
                    expression.left.text !== "groundSize"
                ) {
                    return false;
                }
                const product = this.context.unwrapExpression(
                    expression.right,
                );
                return (
                    ts.isBinaryExpression(product) &&
                    product.operatorToken.kind ===
                        ts.SyntaxKind.AsteriskToken &&
                    ts.isIdentifier(product.left) &&
                    product.left.text ===
                        "sceneDiagonalLength" &&
                    ts.isNumericLiteral(product.right)
                );
            },
        );
        if (diagonalOverrides.length !== 1) {
            this.context.contractError(
                declaration,
                "Expected one diagonal-driven ground override.",
            );
        }
        const diagonalScale = this.context.numericValue(
            (
                this.context.unwrapExpression(
                    diagonalOverrides[0]!.right,
                ) as ts.BinaryExpression
            ).right,
            file,
        );
        const skyboxFollows = assignments.filter(
            (expression) =>
                expression.operatorToken.kind ===
                    ts.SyntaxKind.EqualsToken &&
                ts.isIdentifier(expression.left) &&
                expression.left.text === "skyboxSize" &&
                ts.isIdentifier(
                    this.context.unwrapExpression(
                        expression.right,
                    ),
                ),
        );
        if (
            !skyboxFollows.some(
                (expression) =>
                    (
                        this.context.unwrapExpression(
                            expression.right,
                        ) as ts.Identifier
                    ).text === "groundSize",
            )
        ) {
            this.context.contractError(
                declaration,
                "Expected the skybox to follow the overridden ground size.",
            );
        }
        // The final scales, each tied to the variable it multiplies.
        const scaleOf = (name: string): number => {
            const scaled = assignments.filter(
                (expression) =>
                    expression.operatorToken.kind ===
                        ts.SyntaxKind.AsteriskEqualsToken &&
                    ts.isIdentifier(expression.left) &&
                    expression.left.text === name,
            );
            if (scaled.length !== 1) {
                this.context.contractError(
                    declaration,
                    `Expected one final '${name}' scale.`,
                );
            }
            return this.context.numericValue(
                scaled[0]!.right,
                file,
            );
        };
        const groundScale = scaleOf("groundSize");
        const skyboxScale = scaleOf("skyboxSize");
        // The root: box centre on x and z (one shared half factor) and the
        // box floor minus a drop on y, each read from its own slot of the
        // pinned rootPosition tuple.
        const root = this.context.unwrapExpression(
            this.context.variableInitializer(
                declaration,
                "rootPosition",
            ),
        );
        if (
            !ts.isArrayLiteralExpression(root) ||
            root.elements.length !== 3
        ) {
            this.context.contractError(
                root,
                "Expected a three-component root position.",
            );
        }
        const centreHalf = (
            element: ts.Expression,
            minName: string,
            deltaName: string,
        ): number => {
            const unwrapped =
                this.context.unwrapExpression(element);
            if (
                !ts.isBinaryExpression(unwrapped) ||
                unwrapped.operatorToken.kind !==
                    ts.SyntaxKind.PlusToken ||
                !ts.isIdentifier(unwrapped.left) ||
                unwrapped.left.text !== minName
            ) {
                this.context.contractError(
                    element,
                    `Expected the root to centre from ${minName}.`,
                );
            }
            const product = this.context.unwrapExpression(
                unwrapped.right,
            );
            if (
                !ts.isBinaryExpression(product) ||
                product.operatorToken.kind !==
                    ts.SyntaxKind.AsteriskToken ||
                !ts.isIdentifier(product.left) ||
                product.left.text !== deltaName
            ) {
                this.context.contractError(
                    element,
                    `Expected the root to scale ${deltaName}.`,
                );
            }
            return this.context.numericValue(
                product.right,
                file,
            );
        };
        const halfX = centreHalf(root.elements[0]!, "minX", "dx");
        const halfZ = centreHalf(root.elements[2]!, "minZ", "dz");
        if (halfX !== halfZ) {
            this.context.contractError(
                root,
                "Expected one shared root centre factor.",
            );
        }
        const floor = this.context.unwrapExpression(
            root.elements[1]!,
        );
        if (
            !ts.isBinaryExpression(floor) ||
            floor.operatorToken.kind !==
                ts.SyntaxKind.MinusToken ||
            !ts.isIdentifier(floor.left) ||
            floor.left.text !== "minY"
        ) {
            this.context.contractError(
                root.elements[1]!,
                "Expected the root floor to drop below minY.",
            );
        }
        const rootDrop = this.context.numericValue(
            floor.right,
            file,
        );
        const { declaration: expand } =
            this.context.functionDeclaration(
                boundsModule,
                "expandWorldAabbForMesh",
            );
        for (const marker of [
            "transformedCenter += coefficient * center[column]!",
            "transformedRadius += Math.abs(coefficient) * extent[column]!",
        ]) {
            if (!expand.getText().includes(marker)) {
                this.context.contractError(
                    expand,
                    `Expected the pinned OBB-to-AABB term '${marker}'.`,
                );
            }
        }
        return {
            groundDefault,
            skyboxDefault,
            cameraRadiusScale,
            diagonalScale,
            groundScale,
            skyboxScale,
            rootHalf: halfX,
            rootDrop,
        };
    }

    private extractConstants(): EnvironmentConstants {
        const parserModule = "src/loader-env/env-parse.ts";
        const parser = this.context.sourceFile(parserModule);
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
        return {
            magic,
            coefficientNames,
            imageType: imageType.right.text,
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
