import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

function sceneProgram(body: string): string {
    return `
    import { createEngine, createSceneContext, registerSceneWithShadowSupport } from "@babylonjs/lite";
    import type { SceneContext } from "@babylonjs/lite";
    async function main(): Promise<void> {
        const engine = await createEngine({});
        const enabled = createSceneContext(engine);
        const disabled = createSceneContext(engine, { defaultRenderTask: false });
        ${body}
    }
`;
}

const cases = [
    {
        name: "enabled-first",
        source: sceneProgram(`
        const scenes: SceneContext[] = [enabled, disabled];
        scenes.reverse();
        for (const scene of scenes) await registerSceneWithShadowSupport(scene);
        for (const scene of scenes) await registerSceneWithShadowSupport(scene);
        `),
    },
    {
        name: "disabled-first",
        source: sceneProgram(`
        const scenes: SceneContext[] = [disabled, enabled];
        scenes.reverse();
        for (const scene of scenes) await registerSceneWithShadowSupport(scene);
        for (const scene of scenes) await registerSceneWithShadowSupport(scene);
        `),
    },
    {
        name: "runtime-populated",
        source: sceneProgram(`
        const scenes: SceneContext[] = [];
        scenes.reverse();
        scenes.push(disabled);
        scenes.push(enabled);
        for (const scene of scenes) await registerSceneWithShadowSupport(scene);
        for (const scene of scenes) await registerSceneWithShadowSupport(scene);
        `),
    },
    {
        name: "conditional",
        source: sceneProgram(`
        const gate = new Float32Array([0]);
        const enabledChoice = gate[0]! > 0 ? disabled : enabled;
        const disabledChoice = gate[0]! > 0 ? enabled : disabled;
        await registerSceneWithShadowSupport(enabledChoice);
        await registerSceneWithShadowSupport(disabledChoice);
        await registerSceneWithShadowSupport(enabledChoice);
        await registerSceneWithShadowSupport(disabledChoice);
        `),
    },
];

const tools = optionalNativeFixtureTools();
for (const { name, source } of cases) {
    test(`${name} scene choices preserve default render-task configuration`, () => {
        const result = compileSource(source);
        assert.match(result.cpp, /configure_scene_render_defaults\(bbl::create_scene_context\([^)]+\), false, 4u\)/);
        assert.match(result.cpp, /state->default_render_task && !\w+\.state->default_render_task_created/);
        assert.match(result.cpp, /default-present/);
        assert.equal(result.cpp.match(/RenderTaskOptions\{"default-render-task"/g)?.length, 1);
        assert.equal(result.cpp.match(/bblscene::bbl_ensure_default_render_task\(/g)?.length, 4);
        assert.ok(result.manifest.adaptations.some(adaptation => adaptation.id === "readable-default-render-task"));
    });

    test(`${name} scene aliases create presentation once and respect disabled scenes`, { skip: !tools }, () => {
        const output = resolve("artifacts", "scene-default-task-check", name);
        mkdirSync(output, { recursive: true });
        writeFileSync(join(output, "program.hpp"), compileSource(source).cpp);
        const executable = join(output, "check.exe");
        runNativeFixtureCompiler(tools!, [
            "/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD",
            `/Fo:${output}\\`, `/Fe:${executable}`, "/I", output, "/I", "native\\include",
            "test\\fixtures\\scene-default-task-check.cpp",
        ]);
        assert.match(execFileSync(executable, { encoding: "utf8" }), /scene-default-task-check: ok/);
    });
}
