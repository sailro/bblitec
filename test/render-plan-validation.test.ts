import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { discoverWindowsBuildTools } from "../src/development-tools.js";
import { LoweringContext } from "../src/lowering/context.js";
import { RendererLowerer } from "../src/lowering/renderer-lowerer.js";
import { cppFunction, runFixtureExecutable } from "./native-fixture.js";
import { runFixtureCompiler } from "./native-fixture-cache.js";

test(
    "zero shader variants refuse draws without unreachable MSVC LTCG code",
    { skip: process.platform !== "win32" },
    () => {
        const renderer = new RendererLowerer(
            new LoweringContext(),
        ).lowerRenderPlan();
        const count = cppFunction(
            renderer.header,
            "constexpr std::uint32_t shader_variant_count(",
        );
        assert.doesNotMatch(renderer.source, /shader_variant_count\(\) \{/);
        const directory = resolve("artifacts", "render-plan-validation");
        mkdirSync(directory, { recursive: true });
        const source = `
#include <array>
#include <cassert>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>
#define BBLITE_NODE_VARIANTS 0
namespace bbl::upstream {
enum class RenderMaterialKind { shader, node, standard };
struct RenderItem { RenderMaterialKind material_kind; std::uint32_t shader_variant; };
struct RenderPlan { std::vector<RenderItem> items; };
struct ShaderVariantInfo { bool draw_reachable; };
${count}
static_assert(shader_variant_count() == 0);
${cppFunction(renderer.source, "const ShaderVariantInfo& shader_variant_info(")}
}
namespace bbl::pal {
${cppFunction(readFileSync("native/src/pal_gpu_shared.cpp", "utf8"), "void validate_render_plan_items(")}
}
int main() {
    using namespace bbl::upstream;
    RenderPlan plan;
    bbl::pal::validate_render_plan_items(plan);
    plan.items.push_back({RenderMaterialKind::standard, 0});
    bbl::pal::validate_render_plan_items(plan);
    plan.items.push_back({RenderMaterialKind::shader, 0});
    bool rejected = false;
    try { bbl::pal::validate_render_plan_items(plan); }
    catch (const std::runtime_error& error) {
        rejected = std::string(error.what()) == "this shader material variant is not implemented yet.";
    }
    assert(rejected);
    plan.items.back().material_kind = RenderMaterialKind::node;
    rejected = false;
    try { bbl::pal::validate_render_plan_items(plan); }
    catch (const std::runtime_error& error) {
        rejected = std::string(error.what()) == "a node material in a build with no composed graphs.";
    }
    assert(rejected);
}
`;
        writeFileSync(join(directory, "validation.cpp"), source);
        const tools = discoverWindowsBuildTools("msvc");
        const executable = join(directory, "validation.exe");
        runFixtureCompiler(
            tools.compiler,
            { ...process.env, ...tools.environment },
            [
                "/nologo",
                "/std:c++20",
                "/W4",
                "/WX",
                "/O1",
                "/GL",
                "/EHsc",
                `/Fo:${directory}/`,
                `/Fe:${executable}`,
                join(directory, "validation.cpp"),
                "/link",
                "/LTCG",
            ],
            resolve("."),
        );
        runFixtureExecutable(executable);
    },
);
