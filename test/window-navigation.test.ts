import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { stringLiteral } from "../src/cpp-literals.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("Location search navigation commits retained query changes into a fresh realm", (t) => {
    const directory = resolve("artifacts/window-navigation-check");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "worker.ts"), "self.close();");
    const generated = compileSource(
        `
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
        void (async () => {
        const query = new URLSearchParams(location.search);
        const step = query.get("step");
        if(step === null) {
            if(query.get("keep") !== "first") throw new Error("initial query");
            setTimeout(() => {
                query.set("step", "two");
                location.search = query.toString();
                if(location.search !== "?keep=first") throw new Error("navigation commits after this task");
            },0);
        } else if(step === "two") {
            if(query.get("keep") !== "first") throw new Error("retained query");
            query.set("step", "three");
            query.set("keep", "new value");
            window.location.search = query.toString();
        } else {
            if(step !== "three" || query.get("keep") !== "new value") throw new Error("replacement query");
            globalThis.close();
        }
        })();
    `,
        { search: "?keep=first", fileName: resolve(directory, "entry.ts") },
    );
    assert.ok(generated.manifest.features.includes("platform:window"));
    assert.match(generated.cpp, /window_location_search/);
    assert.match(generated.cpp, /window_location_set_search/);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const source = readFileSync("native/src/pal_window_realm.cpp", "utf8");
    const functions = [
        "void window_location_reload()",
        "std::string window_location_search(const std::string& initial)",
        "void window_location_set_search(const std::string& value)",
    ]
        .map((signature) => cppFunction(source, signature))
        .join("\n");
    const queryInputs = [
        "",
        "?",
        "??a=1",
        "a=x y",
        "a=🌲",
        "a=\ud800",
        "?a=%bad",
        "a='<>#\"",
        ...Array.from({ length: 128 }, (_, i) => `a=${String.fromCharCode(i)}`),
    ];
    const queryCases = queryInputs
        .map((input) => {
            const url = new URL(
                "https://example.test/demo?original=1#fragment",
            );
            url.search = input;
            const bytes = Buffer.from(input);
            return `assert(location_query(std::string(${stringLiteral(bytes.toString("utf8"))}, ${bytes.length})) == ${stringLiteral(url.search)});`;
        })
        .join("\n");
    const cpp = resolve(directory, "check.cpp"),
        executable = resolve(directory, "check.exe");
    writeFileSync(
        cpp,
        generated.cpp +
            `
        #include <bblite/pal_location.hpp>
        #include <cassert>
        namespace bbl::pal {
            struct TestServices {
                std::shared_ptr<WindowLocation> location = std::make_shared<WindowLocation>();
                bool reload_requested = false;
            };
            struct TestDocument { std::shared_ptr<TestServices> host = std::make_shared<TestServices>(); };
            TestDocument& current_document() { static TestDocument document; return document; }
            ${functions}
            int run_window_application(WorkerEntry initialize, EngineOptions) {
                ${queryCases}
                auto& services=*current_document().host;
                int runs=0;
                do {
                    services.reload_requested=false;
                    const js::RealmScope scope;
                    EventLoop loop;
                    WorkerRealm realm(loop);
                    loop.run([&] { initialize(realm); });
                    ++runs;
                    assert(runs <= 3);
                    if(services.reload_requested)services.location->commit_reload();
                } while(services.reload_requested);
                assert(runs == 3);
                assert(services.location->search("?ignored=1") == "?keep=new+value&step=three");
                return 0;
            }
        }
    `,
    );
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        "/utf-8",
        "/DBBLITE_WORKERS=1",
        "/DBBLITE_HAS_UI=1",
        `/I${resolve("native/include")}`,
        cpp,
        `/Fo${directory}/`,
        `/Fe${executable}`,
    ]);
    assert.equal(
        execFileSync(executable, { encoding: "utf8", timeout: 10000 }),
        "",
    );
});
