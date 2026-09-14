import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("deferred Window, Document and canvas listener cleanup captures the scene engine", t => {
    const native = optionalNativeFixtureTools(false);
    if (!native) { t.skip("Native fixture compiler unavailable."); return; }
    const directory = resolve("artifacts/dom-listener-cleanup");
    mkdirSync(directory, { recursive: true });
    const result = compileSource(`
        import { createEngine, startEngine } from "@babylonjs/lite";
        async function main() {
            const engine = await createEngine({});
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const keyboard = () => {};
            const pointer = () => {};
            window.addEventListener("keydown", keyboard);
            window.addEventListener("keyup", keyboard);
            document.addEventListener("pointerdown", pointer, true);
            canvas.addEventListener("pointerup", pointer);
            const cleanups: Array<() => void> = [];
            const retained: Array<() => void> = [keyboard];
            cleanups.push(() => window.removeEventListener("keydown", keyboard));
            cleanups.push(() => window.removeEventListener("keyup", retained[0]!));
            cleanups.push(() => document.removeEventListener("pointerdown", pointer, true));
            cleanups.push(() => canvas.removeEventListener("pointerup", pointer));
            requestAnimationFrame(() => { for (const cleanup of cleanups) cleanup(); });
            startEngine(engine);
        }
    `);
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    const executable = join(directory, "check.exe");
    runNativeFixtureCompiler(native, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD",
        `/Fo:${directory}/`, `/Fe:${executable}`, "/I", "native/include", "/I", directory,
        "test/fixtures/dom-listener-cleanup-check.cpp",
    ]);
    assert.equal(execFileSync(executable, { encoding: "utf8", timeout: 10000 }), "");
});
