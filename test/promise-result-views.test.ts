import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { discoverWindowsBuildTools } from "../src/development-tools.js";
import {
    optionalNativeFixtureTools,
    runFixtureExecutable,
    runGeneratedProgram,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test(
    "Promise result view conversion refusals remain warning-clean under MSVC LTCG",
    { skip: process.platform !== "win32" },
    () => {
        const tools = discoverWindowsBuildTools("msvc");
        const directory = resolve("artifacts/promise-result-views/ltcg");
        mkdirSync(directory, { recursive: true });
        const source = join(directory, "check.cpp");
        const executable = join(directory, "check.exe");
        writeFileSync(
            source,
            `#include <bblite/js_promise.hpp>
#include <cassert>
int main() {
    const bbl::js::RealmScope realm;
    bbl::pal::EventLoop loop;
    bool observed = false, refused = false;
    std::weak_ptr<int> retained;
    try {
        loop.run([&] {
            auto original = bbl::js::Promise<int>::resolved(7);
            auto view = bbl::js::Promise<double>::view(original, [](int) -> double {
                throw std::logic_error("conversion refused");
            });
            assert(view == original);
            auto token = std::make_shared<int>(1);
            retained = token;
            view.observe([&, token](double) { observed = true; },
                         [](std::exception_ptr) {});
        });
    } catch (const std::logic_error& error) {
        refused = std::string(error.what()) == "conversion refused";
    }
    assert(refused && !observed && retained.expired());
    for (bool settled : {false, true}) {
        bbl::pal::EventLoop normal;
        normal.run([&] {
            auto original = settled ? bbl::js::Promise<int>::resolved(7)
                                    : bbl::js::Promise<int>{};
            auto view = bbl::js::Promise<double>::view(original, [](int value) {
                return value * 2.0;
            });
            assert(view == original);
            view.observe([&](double value) {
                assert(value == 14);
                observed = true;
                normal.close();
            }, [](std::exception_ptr) {});
            if (!settled) original.resolve(7);
        });
        assert(observed);
        observed = false;
    }
}
`,
        );
        runNativeFixtureCompiler(tools, [
            "/O1",
            "/GL",
            `/Fo:${directory}/`,
            `/Fe:${executable}`,
            source,
            "/link",
            "/LTCG",
        ]);
        runFixtureExecutable(executable, { timeoutMs: 10000 });
    },
);

test("Promise result views retain settlement and promise identities", async (t) => {
    const source = `
        interface Full { x:number; y:number; }
        interface Base { x:number; }
        function widen(input:Promise<number>):Promise<number|string>{return input;}
        (async()=>{
            await Promise.resolve();
            const original=Promise.resolve(1);
            const widened=widen(original);
            const repeated:Promise<number|string>=original;
            const separate:Promise<number|string>=Promise.resolve(1);
            const held=new Set<Promise<number|string>>([widened,repeated,separate]);
            if(widened!==original || held.size!==2 || !held.has(repeated))throw new Error('promise identity/hash');
            if(!held.delete(repeated)||held.size!==1||held.has(widened))throw new Error('promise aliases');
            const value=await widened;
            if(value!==1)throw new Error('union settlement');
            const object:Full={x:1,y:2};
            const full:Promise<Full>=Promise.resolve(object);
            const base:Promise<Base>=full;
            const a=await base,b=await base;
            if(a!==b||a!==object)throw new Error('settled object identity');
            a.x=9;
            const read=await full;
            if(object.x!==9||read.x!==9)throw new Error('settled aliases');
            globalThis.close();
        })();
    `;
    let closed = false;
    await runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.None,
            },
        }).outputText,
        {
            close: () => {
                closed = true;
            },
        },
    );
    assert.equal(closed, true);
    const result = compileSource(source);
    const native = optionalNativeFixtureTools(false);
    await t.test("native assertions", { skip: !native }, () => {
        runGeneratedProgram(
            native!,
            "promise-result-views/identity",
            result.cpp,
            {
                flags: ["/DBBLITE_WORKERS=1"],
                timeoutMs: 10000,
                expectedOutput: "",
            },
        );
    });
});

test("Promise result views refuse aliased array representation copies", () => {
    assert.throws(
        () =>
            compileSource(`
        const values:number[]=[1];
        const source:Promise<number[]>=Promise.resolve(values);
        const widened:Promise<Array<number|string>>=source;
        void widened.then(result=>{result.push('next');if(values.length!==2)throw new Error('alias');});
    `),
        /array stored as an array of another element type is a copy/,
    );
});
