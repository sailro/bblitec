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

test("Window media queries retain typed nullable values, live matches and change listeners", (t) => {
    const directory = resolve("artifacts/media-query");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const result = compileSource(
        `
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
        interface Slot { read: (() => number) | null; optional?: () => number; }
        const slots: Slot[] = [{ read: null }];
        function nullType(value: (() => number) | null): string { return typeof value; }
        function optionalType(value?: () => number): string { return typeof value; }
        if (typeof slots[0]!.read !== "object" || typeof slots[0]!.optional !== "undefined" ||
            nullType(null) !== "object" || optionalType() !== "undefined")
            throw new Error("absent callback type");
        slots[0]!.read = () => 1;
        slots[0]!.optional = () => 2;
        if (typeof slots[0]!.read !== "function" || typeof slots[0]!.optional !== "function" ||
            nullType(slots[0]!.read) !== "function" || optionalType(slots[0]!.optional) !== "function")
            throw new Error("present callback type");
        let source: ((query: string) => MediaQueryList) | null = null;
        let cached: MediaQueryList | null = null;
        let acquisitions = 0;
        function motion(): boolean {
            const match = typeof window === "undefined" ? undefined : window.matchMedia;
            if (typeof match !== "function") return false;
            if (match !== source || cached === null) {
                source = match;
                acquisitions++;
                cached = match.call(window, "(prefers-reduced-motion: reduce)");
            }
            return cached?.matches === true;
        }
        if (motion() || motion() || acquisitions !== 1) throw new Error("cached function identity");
        if (window.matchMedia !== globalThis.matchMedia || window.matchMedia !== matchMedia)
            throw new Error("global function identity");
        let fallbacks = 0;
        function fallback(): MediaQueryList { fallbacks++; return matchMedia("(resolution: 1dppx)"); }
        const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? fallback();
        if (fallbacks !== 0 || reduced.matches) throw new Error("initial motion state");
        if (!window.matchMedia("(prefers-reduced-motion: no-preference)").matches) throw new Error("live direct read");
        if (matchMedia("(hover: none) and (pointer: coarse)").matches ||
            !matchMedia("(pointer: fine) and (hover: hover)").matches) throw new Error("native input capabilities");
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
        const listener = () => {
            if (!reduced.matches) throw new Error("change observes new preference");
            state.changes++;
        };
        const removed = () => { throw new Error("removed media listener"); };
        reduced.addEventListener("change", listener);
        reduced.addEventListener("change", listener);
        reduced.addEventListener("change", removed);
        reduced.removeEventListener("change", removed);
        setTimeout(() => {
            if (state.changes !== 1) throw new Error("change delivery");
            if (!motion() || acquisitions !== 1) throw new Error("cached live media result");
            globalThis.close();
        }, 0);
    `,
        { fileName: join(directory, "entry.ts") },
    );
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    assert.ok(result.cpp.includes("create_media_query"));
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Requires the Windows native fixture compiler.");
        return;
    }
    const executable = join(directory, "check.exe");
    runNativeFixtureCompiler(tools, [
        "/O2",
        "/DBBLITE_WORKERS=1",
        "/DBBLITE_OFFSCREEN_SURFACES=1",
        "/DBBLITE_HAS_UI=1",
        "test/fixtures/media-query-check.cpp",
        "native/src/pal_media_query.cpp",
        `/Fo${directory}/`,
        `/Fe${executable}`,
    ]);
    assert.equal(
        execFileSync(executable, { encoding: "utf8", timeout: 15000 }),
        "",
    );
});
