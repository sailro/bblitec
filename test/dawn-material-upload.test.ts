import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("Dawn material uploads reuse passes and invalidate for frames, source versions, and material replacement", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/dawn-material-upload");
    mkdirSync(directory, { recursive: true });
    const source = join(directory, "check.cpp"),
        executable = join(directory, "check.exe");
    const implementation = readFileSync(
        "native/src/pal_dawn_scene_variants.cpp",
        "utf8",
    );
    writeFileSync(
        source,
        `#include <array>
#include <cassert>
#include <cstdint>
#include <cstring>
#include <optional>
#include <tuple>
#include <vector>
using WGPUBuffer = unsigned;
struct Handle { std::uint32_t value = 999; };
struct MaterialRecord { Handle source_material; std::uint64_t ubo_version = 0; bool no_color = false; float value = 1; };
struct Engine { std::vector<MaterialRecord> materials{3}; };
MaterialRecord* handle_find(std::vector<MaterialRecord>& list, Handle h) { return h.value < list.size() ? &list[h.value] : nullptr; }
const MaterialRecord* handle_find(const std::vector<MaterialRecord>& list, Handle h) { return h.value < list.size() ? &list[h.value] : nullptr; }
const MaterialRecord& handle_at(const std::vector<MaterialRecord>& list, Handle h) { return list.at(h.value); }
struct Scene {};
struct PinnedVelocityHistory {};
struct DawnState { unsigned queue = 0; std::uint64_t material_upload_frame = 0; };
struct DawnDrawState {
 WGPUBuffer mesh_uniforms = 1, material_uniforms = 2, uv_uniforms = 3, uv_transform_uniforms = 4;
 std::optional<std::tuple<std::uint64_t,std::uint64_t,std::size_t,std::uint32_t>> material_upload;
};
namespace upstream {
struct MeshUniforms { float value; };
struct StandardMaterialUniforms { float value; };
struct StandardUvTransformUniforms { float value; };
struct StandardUvTxUniforms { float value; };
struct RenderDrawCommand { struct { Handle material{0}, mesh{0}; } item; };
struct PbrVariantEntry { unsigned material_ubo_bytes = 4; };
const std::array<PbrVariantEntry,2> pbr_variants{};
constexpr std::uint32_t standard_no_color_output_flag = 1;
std::uint32_t standard_material_features(const MaterialRecord&) { return 0; }
void write_pbr_variant_material(std::size_t, const MaterialRecord& material, void* output, unsigned) { std::memcpy(output, &material.value, 4); }
}
upstream::MeshUniforms pinned_mesh_block(const Scene&,const Engine&,Handle,const PinnedVelocityHistory* = nullptr) { return {1}; }
upstream::StandardMaterialUniforms standard_material_block(const MaterialRecord* material, std::uint32_t) { return {material->value}; }
upstream::StandardUvTransformUniforms standard_uv_block(const MaterialRecord* material, std::uint32_t) { return {material->value}; }
upstream::StandardUvTxUniforms standard_uv_transform_block(const MaterialRecord* material) { return {material->value}; }
std::array<unsigned,5> writes{};
void wgpuQueueWriteBuffer(unsigned,WGPUBuffer buffer,std::size_t,const void*,std::size_t) { ++writes.at(buffer); }
${readFileSync("test/fixtures/gpu-writer-recorder.hpp", "utf8")}
${["inline std::uint64_t material_ubo_version(", "void write_pinned_draw_blocks(", "void write_standard_draw_blocks("].map((signature) => cppFunction(implementation, signature)).join("\n")}
int main() {
 Engine engine; Scene scene; DawnState state; DawnDrawState draw_state; upstream::RenderDrawCommand draw;
 engine.materials[0].source_material = Handle{2};
 const auto check = [&](bool standard) {
  writes = {}; draw_state.material_upload.reset(); draw.item.material = Handle{0};
  const auto write = [&] {
   if(standard) write_standard_draw_blocks(state,scene,engine,draw,draw_state.mesh_uniforms,draw_state,nullptr);
   else write_pinned_draw_blocks(state,scene,engine,draw,0,draw_state);
  };
  write(); write(); assert(writes[1] == 2 && writes[2] == 1);
  if(standard) assert(writes[3] == 1 && writes[4] == 1);
  ++state.material_upload_frame; write(); assert(writes[2] == 2);
  ++engine.materials[2].ubo_version; write(); assert(writes[2] == 3);
  engine.materials[1].ubo_version = engine.materials[2].ubo_version;
  draw.item.material = Handle{1}; write(); assert(writes[2] == 4);
  write(); assert(writes[2] == 4 && writes[1] == 6);
  draw_state.material_upload.reset(); write(); assert(writes[2] == 5);
 };
 check(false); check(true);
}
`,
    );
    runNativeFixtureCompiler(native, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        "/DBBLITE_HAS_STANDARD_UV_TRANSFORM=1",
        `/Fo:${directory}/`,
        `/Fe:${executable}`,
        source,
    ]);
    execFileSync(executable);
});
