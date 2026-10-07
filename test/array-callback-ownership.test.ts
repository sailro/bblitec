import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { discoverWindowsBuildTools } from "../src/development-tools.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("inlined DOM array callbacks snapshot selected string values", () => {
    const result = compileSource(`
        function buttons(names: readonly string[]): HTMLElement[] {
            return names.map((name, index) => {
                const button = document.createElement("button");
                button.textContent = name;
                button.addEventListener("click", () => { button.title = String(index); });
                return button;
            });
        }
        const names: string[] = ["first", "second"];
        names.push("third");
        const elements = buttons(names);
    `);
    assert.match(
        result.cpp,
        /std::string v_fn\d+_name = bbl::js::snapshot_value\(v_bblite_map_source_\d+\[v_bblite_map_index_\d+\]\);/,
    );
});

test("array callback values survive slot replacement, growth and escaping captures", (t) => {
    const result = compileSource(`
        const original = "first string longer than native inline storage";
        const names: string[] = [original, "second"];
        const captured: (() => string)[] = [];
        const selected = names.map((name, index, source) => {
            captured.push(() => name);
            if (index === 0) {
                source[0] = "replaced";
                for (let count = 0; count < 64; count++) source.push("growth " + count);
            }
            return name;
        });
        if (selected.length !== 2 || selected[0] !== original || selected[1] !== "second" ||
            captured[0]!() !== original || captured[1]!() !== "second" || names[0] !== "replaced")
            throw new Error("callback value snapshot");
        const rewritten = selected.map(name => { name += "!"; return name; });
        if (rewritten[0] !== original + "!" || selected[0] !== original)
            throw new Error("rebound callback parameter");
        const objects: {value: number}[] = [{value: 3}];
        const first = objects[0]!;
        const kept = objects.map((object, index, source) => {
            source[index] = {value: 100};
            source.push({value: 200});
            object.value++;
            return object;
        });
        if (kept.length !== 1 || kept[0] !== first || first.value !== 4 || objects[0]!.value !== 100)
            throw new Error("callback object identity");
        const filterSource: string[] = ["", original, "last"];
        filterSource.push("");
        if (filterSource.filter(Boolean).join(",") !== original + ",last")
            throw new Error("Boolean string predicate");
    `);
    assert.doesNotMatch(
        result.cpp,
        /snapshot_value\(v_bblite_filter_source_\d+\[/,
    );
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(native, "array-callback-ownership", result.cpp);
});

test("array callback resource snapshots preserve Scene and Engine identity", (t) => {
    if (process.platform !== "win32")
        return t.skip("The clang-cl native fixture requires Windows.");
    let native;
    try {
        native = discoverWindowsBuildTools("clangcl");
    } catch {
        return t.skip("The clang-cl native fixture compiler is unavailable.");
    }
    const result = compileSource(`
        import { createEngine, createSceneContext, type SceneContext, type EngineContext } from "@babylonjs/lite";
        const engine = await createEngine({});
        const first = createSceneContext(engine, {defaultRenderTask: false});
        const second = createSceneContext(engine, {defaultRenderTask: false});
        const scenes: SceneContext[] = [];
        if (engine.drawCallCount === 0) scenes.push(first);
        const saved: (() => SceneContext)[] = [];
        const selected = scenes.map((scene, index) => {
            saved.push(() => scene);
            scenes.splice(index, 1, second);
            for (let count = 0; count < 64; count++) scenes.push(second);
            scene.imageProcessing.exposure = 3;
            return scene;
        });
        if (selected.length !== 1 || selected[0] !== first || saved[0]!() !== first ||
            scenes[0] !== second)
            throw new Error("scene callback snapshot identity");
        const rebound = selected.map(scene => {
            scene = second;
            scene.imageProcessing.exposure = 7;
            return scene;
        });
        if (rebound[0] !== second || selected[0] !== first)
            throw new Error("scene parameter rebinding");
        const engines: EngineContext[] = [engine];
        const engineScenes = engines.map(current => {
            return createSceneContext(current, {defaultRenderTask: false});
        });
        if (engineScenes.length !== 1) throw new Error("engine callback result");
        const originalError = new Error("original");
        const errors: Error[] = [originalError];
        const messages = errors.map((error, index, source) => {
            source[index] = new Error("replacement");
            return error.message;
        });
        if (messages[0] !== "original" || errors[0]!.message !== "replacement" || originalError.message !== "original")
            throw new Error("error callback storage projection");
    `);
    runGeneratedProgram(
        native,
        "array-callback-resource-ownership",
        `
#define main generated_main
${result.cpp}
#undef main
#include <cassert>
namespace { std::vector<std::shared_ptr<bbl::SceneState>> scene_states; }
namespace bbl {
Engine create_engine(EngineOptions) { return {}; }
Scene create_scene_context(Engine& engine) {
    if (!scene_states.empty()) assert(scene_states[0]->engine == &engine);
    Scene scene;
    scene.engine = &engine;
    scene_states.push_back(scene.state);
    return scene;
}
}
int main() {
    assert(generated_main() == 0);
    assert(scene_states.size() == 3);
    assert(scene_states[0]->environment.exposure == 3.0f);
    assert(scene_states[1]->environment.exposure == 7.0f);
}
`,
    );
});

test("array callbacks refuse at run time an element they removed before visiting it", (t) => {
    // JavaScript reads such an index as undefined (find*) or leaves a hole
    // in the result (map); neither the element type nor a dense array
    // holds that, so the walk throws where it would read it.
    const result = compileSource(`
        const refused: string[] = [];
        function attempt(run: () => number): void {
            try { run(); } catch (error) { refused.push((error as Error).message); }
        }
        attempt(() => { const xs: number[] = [1, 2, 3]; return xs.map((value, _index, array) => { array.pop(); return value; }).length; });
        attempt(() => { const xs: number[] = [1, 2, 3]; return xs.find((value, _index, array) => { array.pop(); return value > 5; }) ?? 0; });
        attempt(() => { const xs: number[] = [1, 2, 3]; return xs.findIndex((value, _index, array) => { array.pop(); return value > 5; }); });
        attempt(() => { const xs: number[] = [1, 2, 3]; return xs.findLast((value, _index, array) => { array.shift(); array.shift(); return value > 5; }) ?? 0; });
        attempt(() => { const xs: number[] = [1, 2, 3]; return xs.findLastIndex((value, _index, array) => { array.length = 1; return value > 5; }); });
        const expected = ["map", "find", "findIndex", "findLast", "findLastIndex"]
            .map((method) => "Array." + method + " callback removed an element it has not visited.");
        if (refused.join("|") !== expected.join("|")) throw new Error(refused.join("|"));
    `);
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(native, "array-callback-removed-elements", result.cpp);
});

test("array callbacks that cannot write the receiver walk it unchecked", () => {
    const result = compileSource(`
        const values: number[] = [3, 1, 4];
        let total = 0;
        values.forEach((value, index) => { total += value * index; });
        const doubled = values.map((value) => value * 2);
        const big = values.filter((value) => value > 1);
        const sum = values.reduce((acc, value) => acc + value);
        const fromRight = values.reduceRight((acc, value) => acc - value);
        const last = values.findLast((value) => value < 4);
        const flat = values.flatMap((value) => [value, value]);
        const sorted = values.sort((a, b) => a - b);
        if (total + doubled.length + big.length + sum + fromRight + (last ?? 0) + flat.length + sorted.length === 0)
            throw new Error("unreachable");
    `);
    assert.doesNotMatch(result.cpp, /\.size\(\)\) (?:continue|throw)/);
    assert.doesNotMatch(result.cpp, /auto v_bblite_\w+_source_\d+ = /);
    assert.doesNotMatch(result.cpp, /sort_receiver/);
});
