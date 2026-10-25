import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerSceneDisposalCallbacks } from "../src/lowering/scene-disposal.js";
import { transpileCommonJs } from "../src/typescript-transpile.js";
import { doctoredContext } from "./doctored-store.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const module = "src/scene/scene-change.ts";

test("scene disposal preserves callback order, cleanup and source failure aggregation", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    for (const [id, context] of [
        ["pinned", new LoweringContext()],
        [
            "changed",
            doctoredContext(
                module,
                "callback();\n        } catch (error) {\n            failures.push(error);",
                "callback();\n        } catch (error) {\n            failures.push(error); failures.push(error);",
            ),
        ],
    ] as const) {
        const declarations = ["throwFailures", "disposeSceneCallbacks"]
            .map((name) =>
                context.functionDeclaration(module, name).declaration.getText(),
            )
            .join("\n");
        const expected: unknown = runInNewContext(
            transpileCommonJs(
                declarations +
                    `
            const results = [];
            for (let mask = 0; mask < 8; ++mask) {
                const calls = [];
                const scene = { _disposables: [] };
                scene._disposables.push(() => {
                    calls.push(1);
                    scene._disposables.push(() => calls.push(99));
                    if (mask & 1) throw new Error("first");
                }, () => { calls.push(2); if (mask & 2) throw new Error("second"); });
                let count = 0;
                try { disposeSceneCallbacks(scene, () => { calls.push(3); if (mask & 4) throw new Error("cleanup"); }); }
                catch (error) { count = error instanceof AggregateError ? error.errors.length : 1; }
                results.push(calls.join("") + ":" + count + ":" + scene._disposables.length);
            }
            results.join(";") + ";";
        `,
                module,
            ),
        );
        assert.equal(typeof expected, "string");
        runGeneratedProgram(
            tools,
            `scene-disposal-${id}`,
            `
#include <bblite/runtime.hpp>
#include <bblite/js_aggregate_error.hpp>
#include <iostream>
using namespace bbl;
${lowerSceneDisposalCallbacks(context)}
int main() {
    for (int mask = 0; mask < 8; ++mask) {
        Scene scene;
        std::string calls;
        scene.disposables.emplace_back([&] {
            calls += "1";
            scene.disposables.emplace_back([&] { calls += "99"; });
            if (mask & 1) throw std::runtime_error("first");
        });
        scene.disposables.emplace_back([&] { calls += "2"; if (mask & 2) throw std::runtime_error("second"); });
        std::size_t count = 0;
        try { dispose_scene_callbacks(scene, [&] { calls += "3"; if (mask & 4) throw std::runtime_error("cleanup"); }); }
        catch (const js::AggregateError& error) { count = error.errors.size(); }
        catch (const std::runtime_error&) { count = 1; }
        std::cout << calls << ":" << count << ":" << scene.disposables.size() << ";";
    }
}
`,
            { expectedOutput: String(expected) },
        );
    }
});

test("scene disposal subscription return is refused when consumed", () => {
    assert.throws(
        () =>
            compileSource(`
        import {createEngine,createSceneContext,onSceneDispose} from "@babylonjs/lite";
        const engine=await createEngine({});
        const scene=createSceneContext(engine);
        const unsubscribe=onSceneDispose(scene,()=>{});
        unsubscribe();
    `),
        /Function-valued call initializer did not return a supported callback/,
    );
});
