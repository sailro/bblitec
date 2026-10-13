import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { CompileError, compileSource } from "../src/compiler.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

/**
 * `sessionStorage`, the top-level browsing session's Web Storage area. The
 * shapes are a real application's restart handoff: availability guards in
 * try/catch, a one-shot marker the next boot reads and clears, and a
 * `Pick<Storage, ...>` dependency defaulted from the global.
 */
const handoff = `
    type RetryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
    const RUNS = "runs";
    const MARKER = "resume-after-restart";
    const RETRY = "readiness-retry";
    function browserRetryStorage(): RetryStorage | null {
        try { return typeof sessionStorage === "undefined" ? null : sessionStorage; } catch { return null; }
    }
    function settleMarker(resume: boolean): void {
        try {
            if (typeof sessionStorage === "undefined") return;
            if (resume) sessionStorage.setItem(MARKER, "1");
            else sessionStorage.removeItem(MARKER);
        } catch {
            // Fail open: the next boot stops on its start screen.
        }
    }
    function takeMarker(): boolean {
        try {
            if (typeof sessionStorage === "undefined") return false;
            const marked = sessionStorage.getItem(MARKER) === "1";
            sessionStorage.removeItem(MARKER);
            return marked;
        } catch {
            return false;
        }
    }
    function createRecovery(storage: RetryStorage | null = browserRetryStorage()): () => boolean {
        let alreadyRetried = false;
        try { alreadyRetried = storage?.getItem(RETRY) === "1"; if (alreadyRetried) storage?.removeItem(RETRY); } catch { /* retained */ }
        return () => {
            if (alreadyRetried) return false;
            try {
                if (!storage) return false;
                storage.setItem(RETRY, "1");
                alreadyRetried = true;
            } catch { return false; }
            return true;
        };
    }
    function countRun(storage: RetryStorage | null = browserRetryStorage()): number {
        if (!storage) return 0;
        const runs = Number(storage.getItem(RUNS) ?? "0") + 1;
        storage.setItem(RUNS, String(runs));
        return runs;
    }
`;

test("sessionStorage lowers to process memory behind its own feature", () => {
    const source = `${handoff}
        settleMarker(true);
        const recovery = createRecovery();
        if (!takeMarker() || takeMarker() || !recovery() || recovery() || countRun() !== 1) throw new Error("session");
    `;
    for (const options of [
        {},
        { deferredCapabilities: "runtime-throw" as const },
    ]) {
        const result = compileSource(source, options);
        assert.equal(result.manifest.deferredCapabilities, undefined);
        assert.ok(result.manifest.features.includes("storage:session"));
        assert.ok(!result.manifest.features.includes("storage:local"));
        assert.ok(
            !result.manifest.runtimeSources.includes("src/pal_storage.cpp"),
            "session storage never links the durable store",
        );
        assert.match(result.cpp, /#include <bblite\/js_storage\.hpp>/);
        assert.match(
            result.cpp,
            /const auto (\w+) = bbl::js::session_storage_object\(\);[\s\S]*?bbl::js::snapshot_callback\(\(\1\)->set_item\)/,
        );
        assert.doesNotMatch(result.cpp, /local_storage_object/);
        assert.ok(
            result.manifest.adaptations.some(
                ({ id }) => id === "native-session-storage",
            ),
        );
    }
    assert.throws(
        () => compileSource("sessionStorage.clear();"),
        (error: unknown) =>
            error instanceof CompileError &&
            /sessionStorage\.clear is not lowered/.test(error.message),
    );
});

test("worker realms read sessionStorage as absent and refuse it", (t) => {
    const directory = resolve("artifacts/web-session-storage-worker");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        resolve(directory, "worker.ts"),
        `const kind: string = typeof sessionStorage; if (kind !== "undefined") throw new Error("worker session"); self.postMessage(kind); self.close();`,
    );
    writeFileSync(
        resolve(directory, "reader.ts"),
        `self.postMessage(sessionStorage.getItem("key") ?? ""); self.close();`,
    );
    const entry = (worker: string): string => `
        const worker = new Worker(new URL("./${worker}", import.meta.url), {type:"module"});
        worker.addEventListener("message", (event: MessageEvent<string>) => {
            if (event.data !== "undefined") throw new Error("worker typeof");
            globalThis.close();
        });
    `;
    const result = compileSource(entry("worker.ts"), {
        fileName: resolve(directory, "entry.ts"),
    });
    assert.ok(!result.manifest.features.includes("storage:session"));
    assert.throws(
        () =>
            compileSource(entry("reader.ts"), {
                fileName: resolve(directory, "entry.ts"),
            }),
        /sessionStorage is not exposed to worker realms/,
    );
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(tools, "web-session-storage-worker", result.cpp, {
        flags: ["/DBBLITE_WORKERS=1"],
        expectedOutput: "",
        timeoutMs: 10000,
    });
});

test("sessionStorage survives realm recreation in process memory", (t) => {
    const directory = resolve("artifacts/web-session-storage-reload");
    mkdirSync(directory, { recursive: true });
    const generated = compileSource(
        `${handoff}
        const areas: Storage[] = [localStorage, sessionStorage];
        if (areas[0] === areas[1] || window.sessionStorage !== sessionStorage) throw new Error("area identity");
        const runs = countRun();
        const marked = takeMarker();
        const recovery = createRecovery();
        if (runs === 1) {
            if (marked || !recovery() || recovery()) throw new Error("first realm");
            areas[1]!.setItem("area", "session");
            if (localStorage.getItem("area") !== null) throw new Error("areas share entries");
            settleMarker(true);
            setTimeout(() => location.reload(), 0);
        } else if (runs === 2) {
            if (!marked || takeMarker() || recovery()) throw new Error("one-shot markers");
            if (areas[1]!.getItem("area") !== "session") throw new Error("session entry");
            settleMarker(false);
            setTimeout(() => location.reload(), 0);
        } else {
            if (runs !== 3 || marked || !recovery()) throw new Error("third realm");
            sessionStorage.removeItem(RUNS);
            if (sessionStorage.getItem(RUNS) !== null) throw new Error("removal");
            globalThis.close();
        }
    `,
        { fileName: resolve(directory, "entry.ts") },
    );
    assert.ok(generated.manifest.features.includes("storage:session"));
    assert.ok(generated.manifest.features.includes("storage:local"));
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const reload = cppFunction(
        readFileSync("native/src/pal_window_realm.cpp", "utf8"),
        "void window_location_reload()",
    );
    runGeneratedProgram(
        tools,
        "web-session-storage-reload",
        generated.cpp +
            `
        #include <bblite/pal_location.hpp>
        #include <cassert>
        #include <exception>
        #include <map>
        #include <thread>
        namespace {
        // The durable store, in memory: session writes must never reach it.
        std::map<std::string, std::string> durable;
        }
        namespace bbl::pal {
            std::optional<std::string> read_local_storage(const std::string& key) {
                const auto found = durable.find(key);
                return found == durable.end() ? std::nullopt : std::optional<std::string>{found->second};
            }
            void write_local_storage(const std::string& key, const std::string& value) { durable[key] = value; }
            void remove_local_storage(const std::string& key) { durable.erase(key); }
            struct TestServices {
                std::shared_ptr<WindowLocation> location = std::make_shared<WindowLocation>();
                bool reload_requested = false;
            };
            struct TestDocument { std::shared_ptr<TestServices> host = std::make_shared<TestServices>(); };
            TestDocument& current_document() { static TestDocument document; return document; }
            ${reload}
            int run_window_application(WorkerEntry initialize, EngineOptions) {
                auto& services = *current_document().host;
                int runs = 0;
                do {
                    services.reload_requested = false;
                    std::exception_ptr failure;
                    // Each realm runs on a fresh thread, as a reloaded window's do.
                    std::thread application([&] {
                        try {
                            const js::RealmScope scope;
                            EventLoop loop;
                            WorkerRealm realm(loop);
                            loop.run([&] { initialize(realm); });
                        } catch (...) {
                            failure = std::current_exception();
                        }
                    });
                    application.join();
                    if (failure)
                        std::rethrow_exception(failure);
                    ++runs;
                    assert(runs <= 3);
                } while (services.reload_requested);
                assert(runs == 3);
                assert(durable.empty());
                const auto area = js::session_storage_get_item("area");
                assert(area.has_value() && *area == "session");
                assert(!js::session_storage_get_item("runs").has_value());
                return 0;
            }
        }
    `,
        {
            flags: ["/DBBLITE_WORKERS=1", "/DBBLITE_HAS_UI=1"],
            timeoutMs: 10000,
            expectedOutput: "",
        },
    );
});
