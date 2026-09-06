import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const source = `
    import { createEngine, createSceneContext, stopEngine } from "babylon-lite";
    async function makeEngine(canvas: HTMLCanvasElement) {
        const engine = await createEngine(canvas);
        createSceneContext(engine);
        return engine;
    }
    async function main() {
        const engine = await makeEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
        const alias = engine;
        const nestedAlias = alias;
        stopEngine(nestedAlias);
        stopEngine(engine);
    }
`;

test("retains an engine returned by a helper without copying or recreating it", () => {
    const result = compileSource(source);
    assert.equal(result.cpp.match(/bbl::create_engine\(/g)?.length, 1);
    const owner = /auto (\w+) = bbl::create_engine\(/.exec(result.cpp)?.[1];
    assert.ok(owner);
    assert.equal(result.cpp.match(new RegExp(`bbl::stop_engine\\(${owner}\\)`, "g"))?.length, 2);
});

test("still refuses a second engine allocation", () => {
    assert.throws(() => compileSource(`
        import { createEngine } from "babylon-lite";
        async function main() {
            const first = await createEngine({});
            const alias = first;
            const second = await createEngine({});
        }
    `), /supports one engine per entry point/);
});

test("refuses an engine alias that would need rebinding storage", () => {
    assert.throws(() => compileSource(`
        import { createEngine } from "babylon-lite";
        async function main() {
            const engine = await createEngine({});
            let alias = engine;
            alias = engine;
        }
    `), /Reassigning an engine alias is not supported/);
});

test("compiled helper and alias operations address the scene's original engine", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Requires the Windows native fixture compiler.");
        return;
    }
    const directory = resolve("artifacts/engine-alias-check");
    mkdirSync(directory, { recursive: true });
    const generated = resolve(directory, "main.cpp");
    const executable = resolve(directory, "check.exe");
    writeFileSync(generated, compileSource(source).cpp);
    runNativeFixtureCompiler(tools, [
        "/nologo", "/std:c++20", "/EHsc", "/W4", "/WX", "/MD",
        `/I${resolve("native/include")}`,
        generated,
        resolve("test/fixtures/engine-alias-check.cpp"),
        `/Fo${directory}/`, `/Fe${executable}`,
    ]);
    execFileSync(executable, { stdio: "pipe", timeout: 10000 });
});
