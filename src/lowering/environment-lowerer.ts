import ts from "typescript";
import { LoweredSource, LoweringContext } from "./context.js";
import { assertEnvironmentTextureIdentity } from "./scene-uniform-identity.js";
import { assertAsyncSceneBuilder } from "./scene-deferred.js";
import {
    COLOR_CHANNEL_HELPERS_CPP,
    lowerShPrescaleCpp,
} from "./gltf-lowerer.js";
import { pinnedHeader } from "./pinned-header.js";
import {
    lowerWorldAabbHelpers,
    worldAabbLaneBindings,
} from "./world-bounds-lowerer.js";
import {
    lowerPinnedFunction,
    lowerTupleComponents,
} from "./pinned-function-lowerer.js";
import { type PinnedBinding } from "./pinned-numeric-lowerer.js";
import { recordAt } from "../compiler/record-access.js";
import { sameSource } from "../compiler/syntax.js";

/** The DDS background composite, reached without the `.env` loader. */
const DDS_BACKGROUND_MODULE = "src/material/pbr/background-dds-environment.ts";

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
        const { file, declaration } = this.context.functionDeclaration(
            modulePath,
            symbolName,
        );
        const sizeParameter = declaration.parameters[3];
        if (
            !sizeParameter?.initializer ||
            this.context.numericValue(sizeParameter.initializer, file) !== 100
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
            this.context.functionDeclaration(cubeModulePath, "loadCubeTexture");
        const faceSuffixes = ["_px", "_nx", "_py", "_ny", "_pz", "_nz"];
        if (
            !this.context.hasNode(
                loadCubeTexture,
                (node) =>
                    ts.isArrayLiteralExpression(node) &&
                    node.elements.length === faceSuffixes.length &&
                    node.elements.every(
                        (element, index) =>
                            ts.isStringLiteral(element) &&
                            element.text === faceSuffixes[index],
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
        if (!this.context.hasCall(loadCubeTexture, "mipLevelCount")) {
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
    double size) {
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
            throw new Error(
                `Unsupported pinned environment image type: ${constants.imageType}.`,
            );
        }
        const magic = constants.magic
            .map((value) => `0x${value.toString(16).padStart(2, "0")}`)
            .join(", ");
        const keys = constants.coefficientNames
            .map((value) => `"${value}"`)
            .join(", ");
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
            header: pinnedHeader(
                [
                    "<bblite/runtime.hpp>",
                    "",
                    "<array>",
                    "<cstdint>",
                    "<vector>",
                ],
                `
struct ParsedEnvironment {
    std::array<Color3, 9> spherical_harmonics{};
    std::uint32_t width = 0;
    std::uint32_t mip_count = 0;
    std::vector<TextureData> faces;
};

ParsedEnvironment parse_env_file(const std::vector<std::uint8_t>& bytes);
`,
            ),
            source: `// ${this.context.provenance(
                modulePath,
                symbolName,
                "src/loader-env/load-env.ts#polynomialToPreScaledHarmonics",
            )}
#include <bblite/upstream/env_parse.hpp>
#include <bblite/js_data.hpp>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <array>
#include <stdexcept>
#include <string_view>

namespace bbl::upstream {
namespace {

${COLOR_CHANNEL_HELPERS_CPP}

${prescale}

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
    const auto manifest = nlohmann::json::parse(bytes.begin() + 8, terminator);
    const auto& irradiance = manifest.at("irradiance");
    const std::array<std::string_view, 9> coefficient_names{${keys}};
    std::array<Color3, 9> polynomial{};
    for (std::size_t index = 0; index < coefficient_names.size(); ++index) {
        const auto& coefficient = irradiance.at(coefficient_names[index]);
        polynomial[index] = Color3{
            coefficient.at(0).get<float>(),
            coefficient.at(1).get<float>(),
            coefficient.at(2).get<float>()};
    }
    const std::uint32_t width = gpu_u32(gpu_size(manifest.at("width").get<double>()));
    const std::uint32_t mip_count = mip_level_count(width);
    const auto& mipmaps = manifest.at("specular").at("mipmaps");
    if (!mipmaps.is_array() || mipmaps.size() != static_cast<std::size_t>(mip_count) * 6) {
        throw std::runtime_error("Environment mipmap count is not six faces per level.");
    }

    ParsedEnvironment result;
    result.spherical_harmonics = pre_scale_harmonics(polynomial);
    result.width = width;
    result.mip_count = mip_count;
    result.faces.reserve(mipmaps.size());
    for (const auto& mipmap : mipmaps) {
        const auto position = js::buffer_view_index(mipmap.at("position").get<double>());
        const auto length = js::buffer_view_index(mipmap.at("length").get<double>());
        const auto available = bytes.size() - binary_start;
        if (position > available || length > available - position)
            throw std::runtime_error("Environment mipmap exceeds file.");
        const std::size_t start = binary_start + position;
        const std::size_t end = start + length;
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
        const { file, declaration } = this.context.functionDeclaration(
            modulePath,
            symbolName,
        );
        assertEnvironmentTextureIdentity(
            this.context,
            declaration,
            "src/loader-env/env-helpers.ts",
        );
        assertAsyncSceneBuilder(this.context, declaration);
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
        if (
            !this.context.hasNode(
                declaration,
                (node) =>
                    ts.isPropertyAssignment(node) &&
                    ts.isIdentifier(node.name) &&
                    node.name.text === "skipSkybox" &&
                    this.context.expressionMatchesShape(
                        node.initializer,
                        "skyboxIsDds || skyboxIsEnv || options?.skipSkybox",
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
#include <bblite/js_data.hpp>
#include <bblite/pal.hpp>
#include <bblite/runtime.hpp>
${options.loadEnvironment ? "#include <bblite/upstream/env_parse.hpp>\n" : ""}#include <bblite/upstream/renderer_plan.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <optional>
#include <stdexcept>
#include <utility>
#include <vector>

namespace bbl {

namespace {

${lowerWorldAabbHelpers(this.context, { emptyAccumulator: true })}

void expand_scene_mesh_bounds(WorldAabb& acc, const Scene& scene, MeshHandle handle) {
    const MeshRecord& record = ${recordAt("scene.engine->meshes", "handle")};
    if (record.geometry >= scene.engine->geometries.size()) return;
    const ModelGeometry& geometry = scene.engine->geometries[record.geometry];
    WorldAabbMesh mesh;
    mesh.bound_min = {geometry.bounds_min.x, geometry.bounds_min.y, geometry.bounds_min.z};
    mesh.bound_max = {geometry.bounds_max.x, geometry.bounds_max.y, geometry.bounds_max.z};
    mesh.world_matrix = upstream::mesh_world_matrix(*scene.engine, record);
    read_thin_instance_world_bounds(mesh, record);
    expand_world_aabb_for_mesh(acc, mesh);
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

${this.lowerSceneSize()}

void apply_scene_size(Scene& scene, std::optional<double> requested_skybox_size) {
    const auto size = compute_scene_size(scene, requested_skybox_size);
    scene.environment.ground_size = size.ground_size;
    scene.environment.skybox_size = size.skybox_size;
    scene.environment.ground_position = Vec3d{
        size.root_position[0], size.root_position[1], size.root_position[2]};
    scene.environment.skybox_position = scene.environment.ground_position;
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
    const double requested_skybox_size = options.skybox_size;
    scene.deferred_builders.emplace_back(
        [&scene, requested_skybox_size]() {
            apply_scene_size(scene, requested_skybox_size);
        }, SceneDeferredFailure::promise_rejection);
}
`
        : ""
}${
                options.loadEnvironment
                    ? `
std::shared_ptr<const EnvironmentState> load_environment(Scene& scene, EnvironmentOptions options) {
    upstream::ParsedEnvironment parsed =
        upstream::parse_env_file(pal::read_binary_file(options.environment_url));
    EnvironmentState environment = scene.environment;
    environment.has_irradiance = true;
    environment.spherical_harmonics = parsed.spherical_harmonics;
    environment.specular_width = parsed.width;
    environment.specular_mip_count = parsed.mip_count;
    environment.specular_faces = std::move(parsed.faces);
    environment.specular_rgba16f = false;
    environment.brdf_lut = {};
    if (!options.brdf_url.empty()) {
        environment.brdf_lut.bytes = pal::read_binary_file(options.brdf_url);
    }
    scene.environment = std::move(environment);
    scene.state->environment_identity = next_scene_uniform_object_identity();
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
    const std::optional<double> requested_skybox_size =
        options.skybox_size;
    scene.deferred_builders.emplace_back(
        [&scene, requested_skybox_size]() {
            apply_scene_size(scene, requested_skybox_size);
        }, SceneDeferredFailure::promise_rejection);
    scene.environment.exposure = ${this.context.floatLiteral(exposure)};
    scene.environment.contrast = ${this.context.floatLiteral(contrast)};
    scene.environment.tone_mapping_enabled = true;
    return std::make_shared<const EnvironmentState>(scene.environment);
}
`
                    : ""
            }
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
        const { file, declaration } = this.context.functionDeclaration(
            DDS_BACKGROUND_MODULE,
            "addDdsEnvironmentBackground",
        );
        assertAsyncSceneBuilder(this.context, declaration);
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
                    sameSource(node.initializer, "options.enableNoise ?? true"),
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
            if (!sameSource(last, "enableNoise")) {
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
        return {
            sceneSizeCall: ts
                .createPrinter({ removeComments: true })
                .printNode(ts.EmitHint.Expression, sceneSize, file),
        };
    }

    public lowerDdsLoaderAdapter(): LoweredSource {
        const modulePath = "src/loader-env/load-dds-env.ts";
        const symbolName = "loadDdsEnvironment";
        const { file, declaration } = this.context.functionDeclaration(
            modulePath,
            symbolName,
        );
        assertEnvironmentTextureIdentity(
            this.context,
            declaration,
            "src/loader-env/env-helpers.ts",
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
            this.context.hasNode(
                declaration,
                (node) =>
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
        return this.environmentPackageLoader({
            modulePath,
            symbolName,
            provenanceExtra:
                "src/loader-env/load-dds-env.ts#computeSH is compiled into the package by src/dds-packager.ts",
            prefix: "package",
            label: "DDS",
            functionName: "load_dds_environment",
            optionsType: "DdsEnvironmentOptions",
            beforeState: "",
            brdf: `    // The pinned loader decodes the same bundled BRDF PNG the .env loader
    // does (loadBrdfImage then decodeBrdfPng), rather than generating the LUT
    // with a compute pass the way the HDR loader beside it does.
    environment.brdf_lut = {};
    if (!options.brdf_url.empty()) {
        environment.brdf_lut.bytes =
            pal::read_binary_file(options.brdf_url);
    }
`,
            tail: `    // A DDS environment creates no background of its own: the pinned loader
    // takes a cubemap and nothing else.
    scene.environment.has_ground = false;
    scene.environment.has_skybox = false;
    scene.environment.background_enabled_by_default = false;
    scene.environment.lod_generation_scale =
        ${this.context.floatLiteral(lodGenerationScale)};
`,
        });
    }

    public lowerHdrLoaderAdapter(): LoweredSource {
        const modulePath = "src/loader-hdr/load-hdr.ts";
        const symbolName = "loadHdrEnvironment";
        const { file, declaration } = this.context.functionDeclaration(
            modulePath,
            symbolName,
        );
        assertEnvironmentTextureIdentity(
            this.context,
            declaration,
            "src/loader-env/env-helpers.ts",
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
        const lodGenerationScale = this.context.numericValue(
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
        if (toneMapping.right.kind !== ts.SyntaxKind.FalseKeyword) {
            this.context.contractError(
                toneMapping.right,
                "Expected HDR tone mapping to be disabled.",
            );
        }
        return this.environmentPackageLoader({
            modulePath,
            symbolName,
            provenanceExtra:
                "src/loader-hdr/hdr-parser.ts#parseRGBE,computeSHFromEquirect and src/loader-hdr/hdr-ibl-pipeline.ts",
            prefix: "hdr",
            label: "HDR",
            functionName: "load_hdr_environment",
            optionsType: "HdrEnvironmentOptions",
            beforeState: "\n",
            brdf: `
    environment.brdf_lut = {};
    if (!options.brdf_url.empty()) {
        environment.brdf_lut.bytes =
            pal::read_binary_file(options.brdf_url);
        environment.brdf_lut_width = 256;
        environment.brdf_lut_rgba16f = true;
    }
`,
            tail: `    scene.environment.has_ground = false;
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
`,
        });
    }

    /**
     * The compiled environment package both loader adapters read -- the
     * eight-byte magic, the width and mip count, nine SH coefficients, then
     * six faces per mip -- as one C++ parser. The two pinned loaders decode
     * different sources (a DDS through the packager, an HDR through the
     * pin's own IBL pipeline) into that one package, and what they leave on
     * the scene past it is each adapter's own: the BRDF lookup it fills and
     * the background state it sets.
     */
    private environmentPackageLoader(spec: {
        modulePath: string;
        symbolName: string;
        provenanceExtra: string;
        /** The helper prefix and the message label the loader spells. */
        prefix: string;
        label: string;
        functionName: string;
        optionsType: string;
        /** Text between the dimension check and the state build. */
        beforeState: string;
        /** The BRDF lookup fill, before the state is stored. */
        brdf: string;
        /** The state the loader leaves past the identity bump. */
        tail: string;
    }): LoweredSource {
        const { prefix, label } = spec;
        return {
            modulePath: spec.modulePath,
            symbolName: spec.symbolName,
            header: "",
            source: `// ${this.context.provenance(
                spec.modulePath,
                spec.symbolName,
                spec.provenanceExtra,
            )}
#include <bblite/pal.hpp>
#include <bblite/runtime.hpp>

#include <algorithm>
#include <array>
#include <cstring>
#include <stdexcept>

namespace bbl {
namespace {

std::uint32_t ${prefix}_u32(
    const std::vector<std::uint8_t>& bytes,
    std::size_t offset) {
    if (offset + 4 > bytes.size()) {
        throw std::runtime_error("Compiled ${label} package is truncated.");
    }
    return
        static_cast<std::uint32_t>(bytes[offset]) |
        (static_cast<std::uint32_t>(bytes[offset + 1]) << 8) |
        (static_cast<std::uint32_t>(bytes[offset + 2]) << 16) |
        (static_cast<std::uint32_t>(bytes[offset + 3]) << 24);
}

float ${prefix}_f32(
    const std::vector<std::uint8_t>& bytes,
    std::size_t offset) {
    const std::uint32_t bits = ${prefix}_u32(bytes, offset);
    float result = 0.0f;
    static_assert(sizeof(result) == sizeof(bits));
    std::memcpy(&result, &bits, sizeof(result));
    return result;
}

} // namespace

void ${spec.functionName}(
    Scene& scene,
    ${spec.optionsType} options) {
    const std::vector<std::uint8_t> bytes =
        pal::read_binary_file(options.environment_url);
    static constexpr std::array<std::uint8_t, 8> magic{
        0x42, 0x42, 0x4c, 0x48, 0x44, 0x52, 0x31, 0x00};
    if (
        bytes.size() < 124 ||
        !std::equal(magic.begin(), magic.end(), bytes.begin())) {
        throw std::runtime_error("Invalid compiled ${label} environment package.");
    }
    const std::uint32_t width = ${prefix}_u32(bytes, 8);
    const std::uint32_t mip_count = ${prefix}_u32(bytes, 12);
    if (width == 0 || mip_count == 0) {
        throw std::runtime_error("Compiled ${label} environment has invalid dimensions.");
    }
${spec.beforeState}    EnvironmentState environment = scene.environment;
    environment.has_irradiance = true;
    for (std::size_t coefficient = 0; coefficient < 9; ++coefficient) {
        environment.spherical_harmonics[coefficient] = Color3{
            ${prefix}_f32(bytes, 16 + coefficient * 12),
            ${prefix}_f32(bytes, 20 + coefficient * 12),
            ${prefix}_f32(bytes, 24 + coefficient * 12),
        };
    }
    environment.specular_width = width;
    environment.specular_mip_count = mip_count;
    environment.specular_rgba16f = true;
    environment.specular_faces.clear();
    environment.specular_faces.reserve(
        static_cast<std::size_t>(mip_count) * 6);
    std::size_t offset = 124;
    for (std::uint32_t mip = 0; mip < mip_count; ++mip) {
        const std::uint32_t size = std::max(width >> mip, 1u);
        const std::size_t byte_size =
            static_cast<std::size_t>(size) * size * 8;
        for (std::uint32_t face = 0; face < 6; ++face) {
            if (offset + byte_size > bytes.size()) {
                throw std::runtime_error(
                    "Compiled ${label} environment pixel data is truncated.");
            }
            TextureData data;
            data.bytes.assign(
                bytes.begin() + static_cast<std::ptrdiff_t>(offset),
                bytes.begin() +
                    static_cast<std::ptrdiff_t>(offset + byte_size));
            environment.specular_faces.push_back(std::move(data));
            offset += byte_size;
        }
    }
    if (offset != bytes.size()) {
        throw std::runtime_error(
            "Compiled ${label} environment has trailing pixel data.");
    }
${spec.brdf}    scene.environment = std::move(environment);
    scene.state->environment_identity = next_scene_uniform_object_identity();
${spec.tail}}

} // namespace bbl
`,
        };
    }

    /** The complete pinned sizing body over native mesh and camera records. */
    public lowerSceneSize(): string {
        const modulePath = "src/material/pbr/scene-size.ts";
        const { declaration } = this.context.functionDeclaration(
            modulePath,
            "computeSceneSize",
        );
        const body = lowerPinnedFunction(
            this.context,
            modulePath,
            "computeSceneSize",
            [
                {
                    pinned: "scene",
                    kind: "record",
                    cpp: "scene",
                    annotation: "SceneContext",
                    cppType: "Scene",
                },
                {
                    pinned: "userSkyboxSize",
                    kind: "number",
                    cpp: "requested_skybox_size",
                    optional: true,
                    cppType: "std::optional<double>",
                    binding: {
                        cpp: "*requested_skybox_size",
                        type: "scalar",
                        nullish: "!requested_skybox_size.has_value()",
                    },
                },
            ],
            {
                cppName: "compute_scene_size",
                returns: {
                    type: "SceneSize",
                    value: (lowerer, expression) => {
                        if (!expression)
                            this.context.contractError(
                                declaration,
                                "Expected a scene size return value.",
                            );
                        const object =
                            this.context.unwrapExpression(expression);
                        if (!ts.isObjectLiteralExpression(object))
                            this.context.contractError(
                                object,
                                "Expected a scene size record.",
                            );
                        const root = this.context.propertyInitializer(
                            object,
                            "rootPosition",
                        );
                        const rootValue = ts.isArrayLiteralExpression(root)
                            ? `std::array<double, 3>{${lowerTupleComponents(this.context, lowerer, root, { at: root, arity: 3 }).join(", ")}}`
                            : lowerer.expression(root);
                        return `SceneSize{${lowerer.expression(this.context.propertyInitializer(object, "groundSize"))}, ${lowerer.expression(this.context.propertyInitializer(object, "skyboxSize"))}, ${rootValue}}`;
                    },
                },
                localStorage: [
                    {
                        pinned: "acc",
                        initializer: "emptyWorldAabb()",
                        binding: { cpp: "acc", type: "opaque" },
                        declaration: "WorldAabb acc = empty_world_aabb();",
                    },
                ],
                memberBindings: new Map<string, PinnedBinding>([
                    ...worldAabbLaneBindings(this.context, "acc", "acc"),
                    ["scene.meshes", { cpp: "scene.meshes", type: "opaque" }],
                ]),
                calls: new Map([
                    [
                        "expandWorldAabbForMesh",
                        ([acc, mesh]) =>
                            `expand_scene_mesh_bounds(${acc}, scene, ${mesh})`,
                    ],
                    ["isFinite", ([value]) => `std::isfinite(${value})`],
                ]),
                forOf: (iterated, element) =>
                    iterated === "scene.meshes"
                        ? {
                              range: iterated,
                              bindings: new Map([
                                  [element, { cpp: element, type: "opaque" }],
                              ]),
                          }
                        : undefined,
                statement: (statement, lowerer, indent) => {
                    if (
                        !ts.isVariableStatement(statement) ||
                        statement.declarationList.declarations.length !== 1
                    )
                        return undefined;
                    const local = statement.declarationList.declarations[0]!;
                    if (!ts.isIdentifier(local.name) || !local.initializer)
                        return undefined;
                    if (local.name.text === "cam") {
                        this.context.assertExpressionShape(
                            local.initializer,
                            "scene.camera",
                            "Scene camera storage boundary",
                        );
                        lowerer.bindPorts(
                            [
                                [
                                    "cam",
                                    {
                                        cpp: "camera",
                                        type: "opaque",
                                        absentCpp: "camera == nullptr",
                                    },
                                ],
                                [
                                    "cam.upperRadiusLimit",
                                    {
                                        cpp: "camera->upper_radius_limit.value_or(std::numeric_limits<double>::quiet_NaN())",
                                        type: "scalar",
                                    },
                                ],
                            ],
                            local,
                        );
                        return [
                            `${indent}const auto* camera = bbl::handle_find(scene.engine->cameras, scene.camera);`,
                        ];
                    }
                    if (local.name.text !== "rootPosition") return undefined;
                    const values = lowerTupleComponents(
                        this.context,
                        lowerer,
                        local.initializer,
                        { at: local, arity: 3 },
                    );
                    lowerer.bindLocal(local.name, {
                        cpp: "root_position",
                        type: "f64-buffer",
                    });
                    return [
                        `${indent}const std::array<double, 3> root_position{${values.join(", ")}};`,
                    ];
                },
                expression: (expression, lowerer) => {
                    if (
                        !ts.isBinaryExpression(expression) ||
                        expression.operatorToken.kind !==
                            ts.SyntaxKind.InKeyword
                    )
                        return undefined;
                    if (
                        !ts.isStringLiteral(expression.left) ||
                        expression.left.text !== "upperRadiusLimit" ||
                        lowerer.binding(expression.right)?.cpp !== "camera"
                    )
                        this.context.contractError(
                            expression,
                            "Unsupported camera property membership.",
                        );
                    return "camera->kind == CameraKind::arc_rotate";
                },
            },
        );
        return `struct SceneSize {
    double ground_size;
    double skybox_size;
    std::array<double, 3> root_position;
};
${body}`;
    }

    private extractConstants(): EnvironmentConstants {
        const parserModule = "src/loader-env/env-parse.ts";
        const parser = this.context.sourceFile(parserModule);
        const magicExpression = this.context.unwrapExpression(
            this.context.variableInitializer(parser, "ENV_MAGIC"),
        );
        if (
            !ts.isNewExpression(magicExpression) ||
            !ts.isIdentifier(magicExpression.expression) ||
            magicExpression.expression.text !== "U8" ||
            magicExpression.arguments?.length !== 1 ||
            !ts.isArrayLiteralExpression(magicExpression.arguments[0]!)
        ) {
            this.context.contractError(
                magicExpression,
                "Expected ENV_MAGIC byte array.",
            );
        }
        const magic = magicExpression.arguments[0].elements.map((element) =>
            this.context.numericValue(element, parser),
        );
        const keysExpression = this.context.unwrapExpression(
            this.context.variableInitializer(parser, "shKeys"),
        );
        if (!ts.isArrayLiteralExpression(keysExpression)) {
            this.context.contractError(
                keysExpression,
                "Expected spherical-harmonic key array.",
            );
        }
        const coefficientNames = keysExpression.elements.map((element) =>
            this.context.stringValue(element, parser),
        );
        const imageType = this.context.findNodes(
            parser,
            (node): node is ts.BinaryExpression =>
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
                this.context.propertyPath(node.left)?.join(".") ===
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
                node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                this.context.propertyPath(node.left)?.join(".") === path,
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
