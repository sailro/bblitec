import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
    sceneBackendSource,
} from "./native-fixture.js";

test("scene attachments preserve MSAA and sprite contexts retain target, load and stage order", (t) => {
    const tools = optionalNativeFixtureTools(),
        dawnInclude = resolve("artifacts/tools/dawn/include");
    if (!tools || !existsSync(join(dawnInclude, "webgpu/webgpu.h"))) {
        t.skip("Native compiler and GPU headers are required.");
        return;
    }
    const output = resolve("artifacts/scene-stage-contracts");
    mkdirSync(output, { recursive: true });
    for (const [backend, name] of [
        ["Sdl", "sdl"],
        ["Dawn", "dawn"],
    ] as const) {
        const encode = cppFunction(sceneBackendSource(name), "void encode(");
        const stageStart = encode.indexOf(
            "for (const upstream::RenderStage stage : render_plan.stages)",
        );
        const stageEnd = encode.indexOf(
            backend === "Sdl"
                ? "pass.end();"
                : "wgpuRenderPassEncoderEnd(pass);",
            stageStart,
        );
        assert.ok(stageStart >= 0 && stageEnd > stageStart);
        const stages = encode.slice(stageStart, stageEnd);
        const sprites = cppFunction(
            encode,
            "if (!engine.sprite_renderer_contexts().empty())",
        );
        writeFileSync(
            join(output, `${backend}Stages.hpp`),
            `void stages() {\n${stages}\n}\nvoid sprites() {\n${sprites}\n}`,
        );
        if (backend === "Sdl") {
            const meshStart = encode.indexOf("draw_list(draw_lists.opaque);");
            // Through the transparent list's unsplit arm and its brace.
            const meshEnd =
                encode.indexOf(
                    "}",
                    encode.indexOf(
                        "draw_list(draw_lists.transparent);",
                        meshStart,
                    ),
                ) + 1;
            const skybox = encode.indexOf(
                "draw_task_background(",
                encode.indexOf("SdlRenderPass task_pass"),
            );
            const graphStart = encode.lastIndexOf(
                "if (task.render.scene_stages)",
                skybox,
            );
            const graphEnd = encode.indexOf("task_pass.end();", skybox);
            assert.ok(
                meshStart >= 0 &&
                    meshEnd > meshStart &&
                    graphStart >= 0 &&
                    graphEnd > graphStart,
            );
            writeFileSync(
                join(output, `${backend}GraphStages.hpp`),
                `void graph_mesh_stages(bool draw_scene_billboard_stages, FixturePassBreaks* pass_breaks, std::optional<std::function<int()>> resume_pass) {
                ${encode.slice(meshStart, meshEnd)}
            } void graph() { ${encode.slice(graphStart, graphEnd)} }`,
            );
        } else {
            const graphStart =
                [
                    ...encode.matchAll(
                        /draw_list_into\(\s*task_pass,\s*render_task\.draw_lists\.opaque,/g,
                    ),
                ].at(-1)?.index ?? -1;
            // The pass ends after the transparent list's split hook.
            const graphEnd = encode.indexOf(
                "wgpuRenderPassEncoderEnd(task_pass);",
                encode.indexOf(
                    "});",
                    encode.indexOf("pal::draw_split_list(", graphStart),
                ),
            );
            assert.ok(graphStart >= 0 && graphEnd > graphStart);
            writeFileSync(
                join(output, `${backend}GraphStages.hpp`),
                `void graph() { ${encode.slice(graphStart, graphEnd)} }`,
            );
        }
        if (backend === "Sdl") {
            const start = encode.indexOf(
                "SDL_GPUColorTargetInfo color_info{};",
            );
            const end = encode.indexOf(
                "SDL_GPUDepthStencilTargetInfo depth_info{};",
                start,
            );
            assert.ok(start >= 0 && end > start);
            writeFileSync(
                join(output, "color-target.hpp"),
                `SDL_GPUColorTargetInfo color_target() {\n${encode.slice(start, end)}\nreturn color_info;\n}`,
            );
        }
    }
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools, [
        "/DBBLITE_HAS_SPRITE_RENDERER=1",
        "/DBBLITE_HAS_BILLBOARDS=1",
        "/O2",
        "/DSDL_STATIC_LIB",
        `/Fo:${output}/`,
        `/Fe:${executable}`,
        "/I",
        "native/src",
        "/I",
        output,
        `/external:I${dawnInclude}`,
        "test/fixtures/scene-stage-contracts-check.cpp",
    ]);
    assert.equal(execFileSync(executable, { encoding: "utf8" }), "");
});
