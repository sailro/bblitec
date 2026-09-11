import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { compileSource } from "../src/compiler.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("local storage can be injected through nullable method records", async t => {
    const result = compileSource(`
        interface Store { getItem(key:string): string | null; setItem(key:string, value:string): void; }
        function settings(store: Store | null): () => void {
            if (!store) return () => {};
            const saved = store.getItem("setting");
            return () => store.setItem("setting", saved ?? "default");
        }
        let store: Store | null = null;
        let nativeStore: Storage | null = null;
        if (typeof localStorage !== "undefined") nativeStore = localStorage;
        if (nativeStore) store = nativeStore;
        function inspect(source: Storage | null): boolean {
            const view: Store | null = source;
            return !!view;
        }
        if (!inspect(nativeStore) || inspect(null)) throw new Error("nullable storage method view");
        const references: Storage[] = [localStorage];
        if (nativeStore !== localStorage || references[0] !== window.localStorage) throw new Error("storage identity");
        const update = settings(store);
        update();
        settings(null)();
        if (localStorage.getItem("setting") !== "default") throw new Error("injected storage write");
        let argumentEffects = 0;
        function optionalStore(options:{storage:Store|null}):void {
            options.storage?.setItem("setting", (++argumentEffects, "default"));
        }
        let optionalStorage:Storage|null = localStorage;
        optionalStore({storage:optionalStorage});
        optionalStorage = null;
        optionalStore({storage:optionalStorage});
        if (argumentEffects !== 1) throw new Error("optional service argument evaluation");
    `);
    assert.match(result.cpp, /local_storage_get_item/);
    assert.match(result.cpp, /local_storage_set_item/);
    assert.ok(result.manifest.features.includes("storage:local"));
    const native = optionalNativeFixtureTools(false);
    await t.test("injected methods perform native reads and writes", {skip: !native}, () => {
        const directory = resolve("artifacts/injected-web-storage");
        mkdirSync(directory, {recursive:true});
        writeFileSync(join(directory, "program.hpp"), result.cpp);
        const source = join(directory, "check.cpp"), executable = join(directory, "check.exe");
        writeFileSync(source, `
            #define main generated_main
            #include "program.hpp"
            #undef main
            #include <cassert>
            namespace { std::optional<std::string> saved; int reads = 0, writes = 0; }
            namespace bbl::pal {
                std::optional<std::string> read_local_storage(const std::string& key) { assert(key == "setting"); ++reads; return saved; }
                void write_local_storage(const std::string& key, const std::string& value) { assert(key == "setting"); ++writes; saved = value; }
                void remove_local_storage(const std::string&) { saved.reset(); }
            }
            int main() { assert(generated_main() == 0); assert(saved == "default" && reads == 2 && writes == 2); }
        `);
        runNativeFixtureCompiler(native!, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD",
            `/Fo:${directory}/`, `/Fe:${executable}`, "/I", "native/include", source]);
        execFileSync(executable, {stdio:"pipe"});
    });
});

test("storage availability guards reach durable native reads", () => {
    for (const storage of ["localStorage", "window.localStorage", "globalThis.localStorage"]) {
        const result = compileSource(`
            const saved = typeof ${storage} !== "undefined" ? ${storage}.getItem("preferences") : null;
            if (saved) ${storage}.setItem("copy", saved);
        `);
        assert.match(result.cpp, /local_storage_get_item/);
        assert.match(result.cpp, /local_storage_set_item/);
    }
});

test("navigator language reads the runtime system locale and respects lexical shadows", () => {
    for (const navigator of ["navigator", "window.navigator", "globalThis.navigator"]) {
        const result = compileSource(`
            const language = typeof ${navigator} !== "undefined" ? ${navigator}.language || "" : "";
            localStorage.setItem("language", language);
            function local(): string { const navigator = {language:"shadow"}; return navigator.language; }
            if (local() !== "shadow") throw new Error("lexical navigator");
        `);
        assert.match(result.cpp, /bbl::preferred_language\(\)/);
        assert.doesNotMatch(result.cpp, /lexical navigator/);
    }
});

test("environment reports use native identification and configured deployment URLs", () => {
    const result = compileSource(`
        localStorage.setItem("agent", navigator.userAgent);
        localStorage.setItem("url", window.location.href);
        if (location.pathname !== "/app/" || location.href !== "https://example.test/app/?mode=test") throw new Error("deployment environment");
    `, {siteUrl:"https://example.test/app/", search:"?mode=test"});
    assert.match(result.cpp, /bblitec\/native/);
    assert.match(result.cpp, /https:\/\/example.test\/app\/\?mode=test/);
});

test("aliased navigator diagnostics preserve native values and optional browser availability", () => {
    const result = compileSource(`
        const nav = navigator as Navigator & {userAgentData?: {platform?: unknown}; deviceMemory?: unknown};
        const agent = nav.userAgentData?.platform;
        if (agent !== undefined || nav.deviceMemory !== undefined || nav.gpu) throw new Error("browser-only diagnostics");
        if (nav !== window.navigator) throw new Error("navigator identity");
        localStorage.setItem("platform", nav.platform);
        localStorage.setItem("threads", String(nav.hardwareConcurrency));
        localStorage.setItem("language", nav.language);
    `);
    assert.match(result.cpp, /bbl::native_platform\(\)/);
    assert.match(result.cpp, /bbl::logical_processor_count\(\)/);
    assert.match(result.cpp, /bbl::preferred_language\(\)/);
    assert.doesNotMatch(result.cpp, /browser-only diagnostics/);
});

test("performance aliases retain the native clock without a JavaScript heap", () => {
    const result = compileSource(`
        const clock = performance as Performance & { memory?: { usedJSHeapSize?: number } };
        if (clock.memory?.usedJSHeapSize !== undefined) throw new Error("native JavaScript heap");
        if (clock !== window.performance) throw new Error("performance identity");
        const started = clock.now();
        if (performance.now() < started) throw new Error("monotonic clock");
    `);
    assert.doesNotMatch(result.cpp, /native JavaScript heap/);
    assert.match(result.cpp, /performance_milliseconds/);
    assert.match(result.cpp, /native_performance_identity/);
});

test("host location guards preserve query parameters and lexical shadows", () => {
    for (const host of ["location", "window.location", "globalThis.location"]) {
        const result = compileSource(`
            const query = typeof ${host} !== "undefined" ? new URLSearchParams(${host}.search) : null;
            if (query?.get("mode") !== "native") throw new Error("lost host query");
            function local(): string {
                const location = "a lexical value";
                return typeof location;
            }
            if (local() !== "string") throw new Error("shadowed location");
        `, { search: "?mode=native" });
        assert.doesNotMatch(result.cpp, /lost host query|shadowed location/);
    }
});

test("query-controlled optional records initialize only their selected branch", () => {
    for (const search of ["", "?diagnostics"]) {
        const result = compileSource(`
            const query = typeof location !== "undefined" ? new URLSearchParams(location.search) : null;
            interface Diagnostics { enabled: boolean; count: number; entries?: number[]; }
            const state: Diagnostics | null = query?.has("diagnostics") ? { enabled: false, count: 0 } : null;
            if (state) (globalThis as unknown as Record<string, unknown>).diagnostics = state;
        `, { search });
        assert.ok(result.cpp.includes("int main()"));
    }
});

test("query helpers fold nullish guards before numeric conversion", () => {
    for (const search of ["", "?weight=0.5"]) {
        const result = compileSource(`
            const query = new URLSearchParams(location.search);
            function weight(raw: string | null): number {
                const n = raw != null && raw !== "" ? Number(raw) : NaN;
                return Number.isFinite(n) && n > 0 ? Math.min(1, n) : 0.25;
            }
            const chosen = weight(query.get("weight"));
            if (chosen !== ${search ? "0.5" : "0.25"}) throw new Error("query weight");
        `, { search });
        assert.ok(result.cpp.includes("int main()"));
    }
});

test("query readers specialize caller-supplied keys and defaults", () => {
    const result = compileSource(`
        const query = typeof location !== "undefined" ? new URLSearchParams(location.search) : null;
        const numberOr = (key: string, fallback: number): number => {
            const raw = query ? query.get(key) : null;
            if (raw === null || raw.trim() === "") return fallback;
            const n = Number(raw);
            return Number.isFinite(n) && n >= 0 ? n : fallback;
        };
        const first = numberOr("weight", 2);
        const second = numberOr("missing", 3);
        if (first !== 0.5 || second !== 3) throw new Error("query key specialization");
    `, { search: "?weight=0.5" });
    assert.ok(result.cpp.includes("int main()"));
});
