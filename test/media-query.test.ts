import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import test from "node:test";
import {compileSource} from "../src/compiler.js";
import {optionalNativeFixtureTools, runNativeFixtureCompiler} from "./native-fixture.js";

test("Window media queries retain typed nullable values, live matches and change listeners", t => {
    const directory = resolve("artifacts/media-query");
    mkdirSync(directory, {recursive:true});
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const result = compileSource(`
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
        let fallbacks = 0;
        function fallback(): MediaQueryList { fallbacks++; return matchMedia("(resolution: 1dppx)"); }
        const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? fallback();
        if (fallbacks !== 0 || reduced.matches) throw new Error("initial motion state");
        if (!window.matchMedia("(prefers-reduced-motion: no-preference)").matches) throw new Error("live direct read");
        interface State { query: MediaQueryList | null; changes: number; }
        const state: State = {query: reduced, changes: 0};
        function clear(): void { state.query = null; }
        const present = state.query ?? fallback();
        if (present.matches || fallbacks !== 0) throw new Error("lazy optional fallback");
        if (state.query?.matches !== false) throw new Error("present optional read");
        clear();
        if (state.query?.matches !== undefined) throw new Error("absent optional read");
        const resolution = state.query ?? fallback();
        if (!resolution.matches || fallbacks !== 1 || resolution.media !== "(resolution: 1dppx)") throw new Error("optional fallback");
        reduced.addEventListener("change", () => {
            if (!reduced.matches) throw new Error("change observes new preference");
            state.changes++;
        });
        setTimeout(() => {
            if (state.changes !== 1) throw new Error("change delivery");
            globalThis.close();
        }, 0);
    `, {fileName:join(directory, "entry.ts")});
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    assert.ok(result.cpp.includes("create_media_query"));
    const tools = optionalNativeFixtureTools(false);
    if (!tools) { t.skip("Requires the Windows native fixture compiler."); return; }
    const executable = join(directory, "check.exe");
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/EHsc", "/W4", "/WX", "/MD", "/O2", "/Gy",
        "/DBBLITE_WORKERS=1", "/DBBLITE_OFFSCREEN_SURFACES=1", "/DBBLITE_HAS_UI=1", `/I${resolve("native/include")}`,
        "test/fixtures/media-query-check.cpp", "native/src/pal_media_query.cpp", `/Fo${directory}/`, `/Fe${executable}`, "/link", "/OPT:REF"]);
    assert.equal(execFileSync(executable, {encoding:"utf8", timeout:15000}), "");
});
