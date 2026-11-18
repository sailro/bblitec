import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import {
    cppFunction,
    cppRecord,
    cppSection,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
    sceneBackendSource,
} from "./native-fixture.js";

const native = optionalNativeFixtureTools(false);

/**
 * The SDL scene backend's shader texture binding, its sampler stubs and
 * the shared helpers it reads, before a fixture's own variant table and
 * state: the text `upstream` and `state` fill.
 */
function sdlShaderTextureFixture(
    upstream: string,
    state: string,
    lifted: readonly string[],
): string {
    const source = sceneBackendSource("sdl");
    const shared = readFileSync("native/src/pal_sdl_gpu_shared.hpp", "utf8");
    const materials = readFileSync("native/src/pal_gpu_materials.hpp", "utf8");
    const gpuShared = readFileSync("native/src/pal_gpu_shared.cpp", "utf8");
    const vertex = readFileSync("native/src/pal_gpu_vertex.hpp", "utf8");
    return `#include <bblite/runtime.hpp>
#include <cassert>
#include <stdexcept>
#include <unordered_set>
using Uint32 = std::uint32_t;
struct SDL_GPURenderPass {};
struct SDL_GPUTexture {};
SDL_GPUTexture* texture(unsigned id) { static std::array<SDL_GPUTexture, 80> values; return &values.at(id); }
struct SDL_GPUTextureSamplerBinding { SDL_GPUTexture* texture = nullptr; unsigned sampler = 0; };
static unsigned bindings = 0;
static std::vector<SDL_GPUTextureSamplerBinding> submitted;
void SDL_BindGPUFragmentSamplers(SDL_GPURenderPass*, Uint32 first, const SDL_GPUTextureSamplerBinding* values, Uint32 count) {
    assert(first == 0); ++bindings; submitted.assign(values, values + count);
}
void SDL_BindGPUVertexSamplers(SDL_GPURenderPass*, Uint32, const SDL_GPUTextureSamplerBinding*, Uint32) { assert(false); }
void SDL_BindGPUVertexStorageTextures(SDL_GPURenderPass*, Uint32, SDL_GPUTexture* const*, Uint32) { assert(false); }
void SDL_BindGPUFragmentStorageTextures(SDL_GPURenderPass*, Uint32, SDL_GPUTexture* const*, Uint32) { assert(false); }
namespace bbl::upstream {
${upstream}
}
namespace bbl::pal {
${cppRecord(shared, "struct PinnedStageBinding")}
${cppRecord(shared, "struct PinnedStageSlots")}
[[noreturn]] void gpu_error(const char* message) { throw std::runtime_error(message); }
${cppSection(shared, "template <typename Resolve>\ninline void resolve_stage_textures(", "/**\n * The storage sibling")}
${cppRecord(source, "struct ShaderStageTextureSlots")}
${state}
// A render target's current colour texture, and the sampler a written texture.sampler names.
SDL_GPUTexture* sdl_shader_render_texture(const GpuState&, const Engine&, const RenderTextureRef&) { return texture(77); }
unsigned sdl_render_texture_sampler(GpuState&, const TextureSamplerState&) { return 55; }
template <typename SharedTextures>
${cppFunction(vertex, "inline SharedTextures*\nfind_shared_shader_material_textures(")}
template <typename SharedTextures>
${cppFunction(vertex, "inline const SharedTextures&\nshader_draw_textures(")}
${cppFunction(materials, "inline std::string shader_sampler_unmapped(")}
${cppFunction(materials, "inline bool shader_slot_binds_per_draw(")}
${cppFunction(gpuShared, "std::string shader_sampler_shortfall(")}
${lifted.map((signature) => cppFunction(source, signature)).join("\n")}
}
`;
}

/** Compiles and runs one fixture program in `artifacts/<name>`. */
function runFixture(name: string, program: string): void {
    const output = resolve("artifacts", name);
    mkdirSync(output, { recursive: true });
    const file = join(output, "check.cpp"),
        executable = join(output, "check.exe");
    writeFileSync(file, program);
    runNativeFixtureCompiler(native!, [
        file,
        `/Fe:${executable}`,
        `/Fo:${join(output, "check.obj")}`,
    ]);
    execFileSync(executable, { stdio: "pipe" });
}

test(
    "SDL shader texture binding follows active slots and refuses stale or incomplete uploads",
    { skip: !native },
    () => {
        runFixture(
            "material-texture-bindings",
            `${sdlShaderTextureFixture(
                `struct ShaderVariantInfo { const char* name = "fixture"; std::vector<std::string> samplers; };
const ShaderVariantInfo& shader_variant_info(std::uint32_t variant) { static const std::array<ShaderVariantInfo,3> info{{{"fixture",{}},{"fixture",{"albedo"}},{"fixture",{"albedo","normal"}}}}; return info.at(variant); }`,
                `struct SharedShaderMaterialTextures { MaterialHandle material; std::vector<SDL_GPUTextureSamplerBinding> bindings; };
struct GpuMesh { SharedShaderMaterialTextures* shared_shader_textures = nullptr; };
struct GpuState {
    std::vector<std::unique_ptr<SharedShaderMaterialTextures>> shared_shader_material_textures;
    std::array<PinnedStageSlots, 3> shader_vertex_slots, shader_fragment_slots;
    // Each packed texture's declared slot, per program.
    std::array<ShaderStageTextureSlots, 3> shader_vertex_texture_slots, shader_fragment_texture_slots;
    StageTextureBindingScratch shader_texture_binding_scratch;
    unsigned ground_sampler = 33;
};`,
                ["void bind_shader_material_textures("],
            )}
int main() {
    using namespace bbl;
    pal::GpuState state;
    pal::SharedShaderMaterialTextures uploaded{MaterialHandle{0}, {}};
    pal::GpuMesh mesh{&uploaded};
    state.shader_fragment_slots[1].textures = {"albedo"};
    state.shader_fragment_slots[2].textures = {"albedo", "normal"};
    state.shader_fragment_texture_slots[1].sampled = {0};
    state.shader_fragment_texture_slots[2].sampled = {0, 1};
    uploaded.bindings = {{texture(11), 21}};
    Scene scene; Engine engine;
    engine.materials.emplace_back();
    auto& material = engine.materials[0];
    const auto bind = [&](unsigned variant) {
        pal::bind_shader_material_textures(state, nullptr, scene, engine, MaterialHandle{0}, variant, mesh);
    };
    bind(0);
    assert(bindings == 0 && state.shader_texture_binding_scratch.sampled.empty());
    bind(1);
    assert(bindings == 1 && submitted.size() == 1);
    assert(submitted[0].texture == texture(11) && submitted[0].sampler == 21);
    bind(0);
    assert(bindings == 1);
    const auto refuses = [&](unsigned variant, const char* message) {
        bool rejected = false;
        try { bind(variant); } catch (const std::runtime_error& error) {
            rejected = std::string(error.what()).find(message) != std::string::npos;
        }
        assert(rejected && bindings == 1);
    };
    refuses(2, "material carries 1 texture(s)");
    uploaded.bindings[0].sampler = 0;
    refuses(1, "'albedo' is not ready");
    uploaded.bindings = {{texture(11), 21}, {texture(12), 22}};
    bind(2);
    assert(bindings == 2 && submitted.size() == 2);
    assert(submitted[1].texture == texture(12) && submitted[1].sampler == 22);
    // A render target's declared slot binds the target's current texture.
    material.shader_render_textures = {std::nullopt, RenderTextureRef{}};
    bind(2);
    assert(bindings == 3 && submitted[0].texture == texture(11) && submitted[0].sampler == 21);
    assert(submitted[1].texture == texture(77) && submitted[1].sampler == 33);
    material.shader_render_textures.clear();
    uploaded.bindings.clear();
    bool missing = false;
    try { bind(1); } catch (const std::runtime_error&) { missing = true; }
    assert(missing);
    assert(bindings == 3);
}
`,
        );
    },
);

/** A source's variant and a view's that declares names its source lacks. */
const viewVariants = `struct ShaderStorageBufferInfo { const char* name = ""; };
struct ShaderVariantInfo { const char* name = "fixture"; std::vector<const char*> samplers; std::vector<ShaderStorageBufferInfo> storage_buffers; };
const ShaderVariantInfo& shader_variant_info(std::uint32_t variant) { static const std::array<ShaderVariantInfo,2> info{{{"source",{"albedo","normal"},{{"points"}}},{"view",{"carve","albedo","normal"},{{"extra"},{"points"}}}}}; return info.at(variant); }`;

/**
 * A view (material 1) over a source (material 0): carve and extra are the
 * view's own, albedo, normal and points alias the source's, and the
 * source's normal slot is a render target.
 */
const viewMaterials = `
    Engine engine;
    engine.materials.resize(2);
    auto& source = engine.materials[0];
    auto& view = engine.materials[1];
    source.shader_material = view.shader_material = true;
    view.shader_variant = 1;
    view.source_material = MaterialHandle{0};
    view.shader_view_slots = std::make_shared<ShaderViewSlots>(ShaderViewSlots{1, {own_shader_slot, 0, 1}, {own_shader_slot, 0}});
    const auto image = [](unsigned id) { FileTexture made; made.data.rgba_width = id; return made; };
    source.shader_textures = {image(11), FileTexture{}};
    source.shader_render_textures = {std::nullopt, RenderTextureRef{}};
    view.shader_textures = {image(31)};`;

test(
    "SDL binds and uploads each slot of a shader view where its table points, following the source's versions and its own",
    { skip: !native },
    () => {
        runFixture(
            "material-texture-bindings/views",
            `${sdlShaderTextureFixture(
                viewVariants,
                `struct SDL_GPUBuffer {};
SDL_GPUBuffer* buffer(unsigned id) { static std::array<SDL_GPUBuffer, 4> values; return &values.at(id); }
struct SharedShaderMaterialTextures {
    explicit SharedShaderMaterialTextures(int) {}
    MaterialHandle material{};
    std::vector<SDL_GPUTextureSamplerBinding> bindings;
    std::uint64_t texture_version = 0;
    void swap(SharedShaderMaterialTextures& other) noexcept { bindings.swap(other.bindings); }
};
struct GpuMesh { SharedShaderMaterialTextures* shared_shader_textures = nullptr; };
struct GpuState {
    int device = 0;
    std::vector<std::unique_ptr<SharedShaderMaterialTextures>> shared_shader_material_textures;
    std::array<PinnedStageSlots, 2> shader_vertex_slots, shader_fragment_slots;
    std::array<ShaderStageTextureSlots, 2> shader_vertex_texture_slots, shader_fragment_texture_slots;
    StageTextureBindingScratch shader_texture_binding_scratch;
    unsigned ground_sampler = 33;
    struct StorageBuffer { SDL_GPUBuffer* buffer = nullptr; bool lost = false; };
    std::vector<StorageBuffer> storage_buffers;
    struct { void prune() {} } shared_material_images;
};
static unsigned uploads = 0;
// An image slot's upload, named by the texture its width stands for.
void upload_material_slot_texture(GpuState&, SharedShaderMaterialTextures& textures, const TextureData& data) {
    ++uploads; textures.bindings.push_back({texture(data.rgba_width), 21});
}`,
                [
                    "SDL_GPUBuffer* shader_storage_buffer(",
                    "void upload_shader_material_textures(",
                    "SharedShaderMaterialTextures& ensure_shader_material_textures(",
                    "void refresh_shader_material_textures(",
                    "void bind_shader_material_textures(",
                ],
            )}
int main() {
    using namespace bbl;
    using pal::uploads;
    pal::GpuState state;
    state.shader_fragment_slots[1].textures = {"carve", "albedo", "normal"};
    state.shader_fragment_texture_slots[1].sampled = {0, 1, 2};
    Scene scene;${viewMaterials}
    pal::GpuMesh mesh{&pal::ensure_shader_material_textures(state, engine, MaterialHandle{1})};
    const auto bind = [&] {
        pal::bind_shader_material_textures(state, nullptr, scene, engine, MaterialHandle{1}, 1, mesh);
        assert(submitted.size() == 3 && submitted[2].texture == texture(77));
    };
    bind();
    assert(uploads == 2 && submitted[0].texture == texture(31) && submitted[1].texture == texture(11));
    pal::refresh_shader_material_textures(state, engine);
    assert(uploads == 2);
    source.shader_textures[0] = image(12);
    ++source.shader_texture_version;
    pal::refresh_shader_material_textures(state, engine);
    bind();
    assert(uploads == 4 && submitted[0].texture == texture(31) && submitted[1].texture == texture(12));
    view.shader_textures[0] = image(32);
    ++view.shader_texture_version;
    pal::refresh_shader_material_textures(state, engine);
    bind();
    assert(uploads == 6 && submitted[0].texture == texture(32) && submitted[1].texture == texture(12));
    source.shader_storage_buffers = {StorageBufferHandle{1}};
    view.shader_storage_buffers = {StorageBufferHandle{0}};
    state.storage_buffers = {{pal::buffer(0)}, {pal::buffer(1)}};
    const auto& info = upstream::shader_variant_info(1);
    assert(pal::shader_storage_buffer(state, engine, view, info, "points") == pal::buffer(1));
    assert(pal::shader_storage_buffer(state, engine, view, info, "extra") == pal::buffer(0));
}
`,
        );
    },
);

test(
    "Dawn uploads each slot of a shader view where its table points, following the source's versions and its own",
    { skip: !native },
    () => {
        const dawn = sceneBackendSource("dawn");
        const vertex = readFileSync("native/src/pal_gpu_vertex.hpp", "utf8");
        const materials = readFileSync(
            "native/src/pal_gpu_materials.hpp",
            "utf8",
        );
        runFixture(
            "material-texture-bindings/dawn-views",
            `#include <bblite/runtime.hpp>
#include <cassert>
namespace bbl::upstream {
${viewVariants}
}
namespace bbl::pal {
struct DawnSampledTexture { unsigned texture = 0; };
struct DawnSharedShaderMaterialTextures {
    MaterialHandle material{};
    std::uint64_t texture_version = 0;
    std::vector<DawnSampledTexture> textures;
    std::vector<int> image_leases;
};
struct DawnState {
    std::vector<std::unique_ptr<DawnSharedShaderMaterialTextures>> shared_shader_material_textures;
    unsigned released = 0;
    void release_shader_bindings(MaterialHandle) { ++released; }
    struct { void prune() {} } shared_material_images;
};
static unsigned uploads = 0;
// An image slot's upload, named by the texture its width stands for.
void upload_material_slot_texture(DawnState&, DawnSampledTexture& sampled, const TextureData& data, std::vector<int>*) {
    ++uploads; sampled.texture = data.rgba_width;
}
template <typename SharedTextures>
${cppFunction(vertex, "inline SharedTextures*\nfind_shared_shader_material_textures(")}
${cppFunction(materials, "inline bool shader_slot_binds_per_draw(")}
${cppFunction(dawn, "void upload_shader_material_textures(")}
${cppFunction(dawn, "DawnSharedShaderMaterialTextures&\nensure_shader_material_textures(")}
${cppFunction(dawn, "void refresh_shader_material_textures(")}
}
int main() {
    using namespace bbl;
    using pal::uploads;
    pal::DawnState state;${viewMaterials}
    const auto& uploaded = pal::ensure_shader_material_textures(state, engine, MaterialHandle{1});
    const auto holds = [&](unsigned carve, unsigned albedo) {
        assert(uploaded.textures.size() == 3 && uploaded.textures[0].texture == carve &&
               uploaded.textures[1].texture == albedo && uploaded.textures[2].texture == 0);
    };
    holds(31, 11);
    assert(uploads == 2);
    pal::refresh_shader_material_textures(state, engine);
    assert(uploads == 2 && state.released == 0);
    source.shader_textures[0] = image(12);
    ++source.shader_texture_version;
    pal::refresh_shader_material_textures(state, engine);
    holds(31, 12);
    assert(uploads == 4 && state.released == 1);
    view.shader_textures[0] = image(32);
    ++view.shader_texture_version;
    pal::refresh_shader_material_textures(state, engine);
    holds(32, 12);
    assert(uploads == 6 && state.released == 2);
}
`,
        );
    },
);
