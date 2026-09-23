import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerManagedResources } from "../src/lowering/managed-resource-lowerer.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("managed resource families dispose in reverse registration order and preserve retry state", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/managed-resource-lifecycle-check");
    mkdirSync(directory, { recursive: true });
    const cpp = resolve(directory, "check.cpp"),
        exe = resolve(directory, "check.exe");
    writeFileSync(
        cpp,
        `${lowerManagedResources(new LoweringContext()).source}
#include <cassert>
int main(){
 bbl::Engine engine;std::vector<int> order;bool fail=true;
 bbl::register_managed_resource_disposer(engine,[&]{order.push_back(1);});
 bbl::register_managed_resource_disposer(engine,[&]{order.push_back(2);if(fail)throw std::runtime_error("busy");});
 bbl::register_managed_resource_disposer(engine,[&]{order.push_back(3);});
 bool caught=false;try{engine.dispose_managed_resources();}catch(const std::exception&){caught=true;}
 assert(caught&&order==std::vector<int>({3,2}));
 order.clear();fail=false;engine.dispose_managed_resources();assert(order==std::vector<int>({3,2,1}));
 order.clear();engine.dispose_managed_resources();assert(order==std::vector<int>({3,2,1}));
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
        `/I${resolve("native/include")}`,
        cpp,
        `/Fo${directory}/`,
        `/Fe${exe}`,
    ]);
    assert.equal(execFileSync(exe, { encoding: "utf8", timeout: 10000 }), "");
});
