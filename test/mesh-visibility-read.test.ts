import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("mesh visibility reads preserve unset, true and false through stored handles and filters", (t) => {
    const result = compileSource(`
        import {createEngine, createBox, type Mesh} from "babylon-lite";
        async function main() {
            const engine = await createEngine({});
            const meshes: Mesh[] = [createBox(engine, {}), createBox(engine, {})];
            if (meshes[0]!.visible !== undefined) throw new Error("initial visibility");
            meshes[0]!.visible = false;
            meshes[1]!.visible = true;
            if (meshes[0]!.visible !== false || meshes[1]!.visible !== true) throw new Error("stored visibility");
            if (meshes.filter(mesh => mesh.visible !== false).length !== 1) throw new Error("visible filter");
            meshes[0]!.visible = undefined;
            if (meshes[0]!.visible !== undefined || meshes.filter(mesh => mesh.visible !== false).length !== 2) throw new Error("reset visibility");
        }
        main();
    `);
    assert.match(result.cpp, /visible.source_value\(\)/);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler required");
        return;
    }
    const output = resolve("artifacts/mesh-visibility-read");
    mkdirSync(output, { recursive: true });
    const cpp = join(output, "check.cpp");
    writeFileSync(
        cpp,
        `${result.cpp}
        namespace bbl {
        Engine create_engine(EngineOptions) {return {};}
        MeshHandle create_box(Engine& engine, BoxOptions) {
            const auto index = static_cast<std::uint32_t>(engine.meshes.size());
            engine.meshes.emplace_back();
            return MeshHandle{index};
        }
        }
    `,
    );
    const exe = join(output, "check.exe");
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        `/I${resolve("native/include")}`,
        cpp,
        `/Fo${output}/`,
        `/Fe${exe}`,
    ]);
    execFileSync(exe, { encoding: "utf8", timeout: 10000 });
});
