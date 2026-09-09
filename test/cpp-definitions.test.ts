import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { pinnedEffectVariantsHeader } from "../src/pinned-effect-cpp.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("effect declarations stay identical across scene data and link from separate sources", (t) => {
    const first = pinnedEffectVariantsHeader("fixture", [
        { family: "effect", name: "first", fragment: "", bindings: [] },
    ]);
    const second = pinnedEffectVariantsHeader("fixture", [
        { family: "effect", name: "second", fragment: "", bindings: [] },
        { family: "effect", name: "third", fragment: "", bindings: [] },
    ]);
    assert.equal(first.header, second.header);
    assert.notEqual(first.definitions, second.definitions);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) { t.skip("A native compiler is required."); return; }
    const output = resolve("artifacts/test-cpp-definitions");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "effect.hpp"), second.header);
    writeFileSync(join(output, "effect.cpp"), '#include "effect.hpp"\n' + second.definitions);
    writeFileSync(join(output, "main.cpp"), `#include "effect.hpp"
int main() {
    using namespace bbl::upstream;
    try { effect_variants.at(2); return 1; }
    catch (const std::out_of_range&) {}
    try { effect_variant_bindings.at(0); return 1; }
    catch (const std::out_of_range&) {}
    return effect_variants.size() == 2 && effect_variants[0].name == "second" &&
        effect_variants[1].name == "third" && effect_variant_bindings.empty() ? 0 : 1;
}
`);
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/EHsc", "/W4", "/WX",
        `/I${resolve("native/include")}`,
        join(output, "effect.cpp"), join(output, "main.cpp"),
        `/Fe:${executable}`, `/Fo:${output}\\`]);
    assert.equal(execFileSync(executable, { encoding: "utf8" }), "");
});
