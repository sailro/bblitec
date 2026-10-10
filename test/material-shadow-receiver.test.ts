import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { materialShadowReceiverCpp } from "../src/lowering/material-shadow-receiver.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("material shadow receivers follow generator membership and caster views", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(
        tools,
        "material-shadow-receiver-check",
        `#include <bblite/runtime.hpp>
#include <cassert>
namespace bbl::upstream { ${materialShadowReceiverCpp(new LoweringContext())} }
int main() {
    bbl::Engine engine;
    bbl::Scene scene;
    engine.lights.emplace_back();
    engine.lights.emplace_back();
    scene.lights.push_back(bbl::LightHandle{0u});
    engine.lights[1].shadow_generator = bbl::ShadowGeneratorHandle{0u};
    assert(!bbl::upstream::pinned_scene_has_shadows(engine, scene));
    assert(!bbl::upstream::pinned_material_receives_shadows(false, true, false));
    scene.lights.push_back(bbl::LightHandle{1u});
    assert(bbl::upstream::pinned_scene_has_shadows(engine, scene));
    for (bool caster : {false, true}) for (bool receives : {false, true}) for (bool present : {false, true})
        assert(bbl::upstream::pinned_material_receives_shadows(caster, receives, present) == (!caster && receives && present));
    scene.lights.pop_back();
    assert(!bbl::upstream::pinned_scene_has_shadows(engine, scene));
}
`,
        { timeoutMs: 10000, expectedOutput: "" },
    );
});
