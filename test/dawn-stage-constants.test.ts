import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { doubleLiteral } from "../src/cpp-literals.js";
import { composeTextPipeline } from "../src/pinned-text-pipeline.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("Dawn stage descriptors retain independent numeric override keys and values", async (t) => {
    const tools = optionalNativeFixtureTools(false);
    const dawnInclude = resolve("artifacts/tools/dawn/include");
    if (!tools || !existsSync(join(dawnInclude, "webgpu/webgpu.h"))) {
        t.skip("A native fixture compiler and the pinned Dawn headers are required.");
        return;
    }
    const ordinary = await composeTextPipeline({ format: "bgra8unorm", sampleCount: 4,
        depthStencilFormat: "depth24plus-stencil8", depthWrite: true, alphaToCoverage: false });
    const covered = await composeTextPipeline({ format: "bgra8unorm", sampleCount: 4,
        depthStencilFormat: "depth24plus-stencil8", depthWrite: true, alphaToCoverage: true });
    const rows = (values: typeof covered.fragmentConstants): string => values.map(({ id, value }) =>
        `Constant{${id}u, ${doubleLiteral(value)}}`).join(", ");
    const output = resolve("artifacts/test-dawn-stage-constants");
    mkdirSync(output, { recursive: true });
    const source = join(output, "check.cpp");
    const executable = join(output, "check.exe");
    writeFileSync(source, `#include "pal_dawn_constants.hpp"
#include <array>
#include <cassert>
#include <cmath>
#include <cstdint>
#include <string_view>
#include <type_traits>
#include <vector>
struct Constant { std::uint32_t id; double value; };
static_assert(!std::is_copy_constructible_v<bbl::pal::DawnStageConstants>);
static_assert(!std::is_move_constructible_v<bbl::pal::DawnStageConstants>);
int main() {
    WGPURenderPipelineDescriptor descriptor = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
    descriptor.fragment = &fragment;
    const std::array<Constant, ${ordinary.fragmentConstants.length}> ordinary{${rows(ordinary.fragmentConstants)}};
    const std::array<Constant, ${covered.fragmentConstants.length}> covered{${rows(covered.fragmentConstants)}};
    const std::array<Constant, 2> vertex{{{17u, -0.0}, {65535u, 1.0000000298023224}}};
    bbl::pal::DawnStageConstants vertex_values(vertex);
    bbl::pal::DawnStageConstants fragment_values(covered);
    vertex_values.apply(descriptor.vertex);
    fragment_values.apply(fragment);
    assert(descriptor.vertex.constantCount == vertex.size());
    assert(descriptor.fragment->constantCount == covered.size());
    assert(descriptor.vertex.constants != descriptor.fragment->constants);
    assert(std::string_view(descriptor.vertex.constants[0].key.data, descriptor.vertex.constants[0].key.length) == "17");
    assert(std::signbit(descriptor.vertex.constants[0].value));
    assert(descriptor.vertex.constants[1].value == vertex[1].value);
    for (std::size_t i = 0; i < covered.size(); ++i) {
        const auto& actual = descriptor.fragment->constants[i];
        assert(std::string_view(actual.key.data, actual.key.length) == std::to_string(covered[i].id));
        assert(actual.value == covered[i].value);
    }
    bbl::pal::DawnStageConstants ordinary_values(ordinary);
    ordinary_values.apply(fragment);
    assert(fragment.constantCount == 0 && fragment.constants == nullptr);
    assert(descriptor.vertex.constantCount == 2);
    std::vector<Constant> many;
    for (std::uint32_t id = 0; id < 512; ++id) many.push_back({id, id + .5});
    bbl::pal::DawnStageConstants many_values(many);
    many_values.apply(fragment);
    many.clear(); // The descriptor does not borrow producer rows.
    for (std::size_t i = 0; i < fragment.constantCount; ++i) {
        const auto& actual = fragment.constants[i];
        assert(std::string_view(actual.key.data, actual.key.length) == std::to_string(i));
        assert(actual.value == i + .5);
    }
}
`);
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/EHsc", "/W4", "/WX",
        `/I${resolve("native/src")}`, `/I${dawnInclude}`, source, `/Fe:${executable}`, `/Fo:${join(output, "check.obj")}`]);
    assert.equal(execFileSync(executable, { encoding: "utf8" }), "");
});
