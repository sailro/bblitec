import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const source = `
    import { createEngine, startEngine } from "babylon-lite";
    async function main() {
        const engine = await createEngine({});
        let count = 0;
        const tick = (): void => {
            count++;
            if (count > 3) throw new Error("callback ran after its conditional stop");
            if (count < 3) requestAnimationFrame(tick);
        };
        tick();
        if (count !== 1) throw new Error("synchronous prime was deferred");
        await startEngine(engine);
    }
`;

test("a synchronously primed RAF callback retains its conditional requeue", () => {
    const result = compileSource(source);
    assert.match(result.cpp, /animation_frame_once_callbacks\.push_back/);
    assert.doesNotMatch(result.cpp, /\.animation_frame_callbacks\.push_back/);
});

const nativeTools = optionalNativeFixtureTools(false);
test("primed callbacks execute once immediately and stop after their final queued frame", { skip: !nativeTools }, () => {
    const output = resolve("artifacts/primed-animation-frame-check");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "primed.hpp"), compileSource(source).cpp);
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(nativeTools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native\\include", "/I", output,
        "test/fixtures/primed-animation-frame-check.cpp"]);
    execFileSync(executable, { encoding: "utf8" });
});
