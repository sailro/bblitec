import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import test from "node:test";
import {compileSource} from "../src/compiler.js";
import {optionalNativeFixtureTools, runNativeFixtureCompiler} from "./native-fixture.js";

test("application RAF returns cancellable IDs and preserves one-shot repaint scheduling", t => {
    const directory = resolve("artifacts/realm-animation-frame");
    mkdirSync(directory, {recursive:true});
    writeFileSync(join(directory, "worker.ts"), `
        const pending = self.requestAnimationFrame(() => { throw new Error("canceled worker frame"); });
        self.cancelAnimationFrame(pending);
        self.close();
    `);
    const result = compileSource(`
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
        let count = 0;
        let lastTime = 0;
        let pending = 0;
        const canceled = window.requestAnimationFrame(() => { throw new Error("canceled before repaint"); });
        globalThis.cancelAnimationFrame(canceled);
        window.cancelAnimationFrame(NaN);
        cancelAnimationFrame(-1);
        function frame(now: number): void {
            if (now <= lastTime) throw new Error("timestamp did not advance");
            lastTime = now;
            count++;
            if (count === 1) {
                queueMicrotask(() => cancelAnimationFrame(pending));
                requestAnimationFrame(frame);
            } else if (count === 2) {
                globalThis.close();
            } else {
                throw new Error("repeated one-shot frame");
            }
        }
        const first = requestAnimationFrame(frame);
        pending = window.requestAnimationFrame(() => { throw new Error("canceled during repaint"); });
        if (first <= 0 || pending <= first || count !== 0) throw new Error("RAF registration");
    `, {fileName:join(directory, "entry.ts")});
    assert.ok(result.manifest.features.includes("platform:window"));
    assert.doesNotMatch(result.cpp, /bbl::request_animation_frame\(|animation_frame_callbacks/);
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) { t.skip("Requires the Windows native fixture compiler."); return; }
    const executable = join(directory, "check.exe");
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/EHsc", "/W4", "/WX", "/MD", "/O2",
        "/DBBLITE_WORKERS=1", "/DBBLITE_OFFSCREEN_SURFACES=1", "/DBBLITE_HAS_UI=1", `/I${resolve("native/include")}`,
        "test/fixtures/realm-animation-frame-check.cpp", `/Fo${directory}/`, `/Fe${executable}`]);
    assert.equal(execFileSync(executable, {encoding:"utf8", timeout:15000}), "");
});
