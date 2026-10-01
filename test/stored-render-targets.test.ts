import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { RenderTargetLowerer } from "../src/lowering/render-target-lowerer.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("render targets retain identity through containers, records and shared helpers", (t) => {
    const result = compileSource(`
        import { createEngine, createSceneContext, createRenderTarget, createRenderTask,
            type RenderTarget, type SceneContext } from "@babylonjs/lite";
        const engine = await createEngine({});
        const scene = createSceneContext(engine, { defaultRenderTask: false });
        const first = createRenderTarget({format: "rgba8unorm", samples: 1, size: {width: 32, height: 24}});
        const second = createRenderTarget({format: "rgba8unorm", samples: 1, size: {width: 48, height: 36}});
        interface State { current: RenderTarget; targets: Map<string, RenderTarget>; }
        const states = new WeakMap<SceneContext, State>();
        states.set(scene, {current: first, targets: new Map([["first", first], ["second", second]])});
        const otherScene = createSceneContext(engine, {defaultRenderTask: false});
        if (states.has(otherScene)) throw new Error("distinct scene key");
        const sceneAlias = scene;
        if (!states.has(sceneAlias)) throw new Error("aliased scene key");
        const state = states.get(scene)!;
        const selected = state.targets.get("first")!;
        if (selected !== first || selected === second || state.targets.get("missing") !== undefined)
            throw new Error("target lookup identity");
        state.current = second;
        if (states.get(scene)!.current !== second) throw new Error("record alias");
        const unique = new Set<RenderTarget>([first, selected, second]);
        const labels = new WeakMap<RenderTarget, string>([[first, "first"], [second, "second"]]);
        if (unique.size !== 2 || !unique.has(selected) || labels.get(selected) !== "first")
            throw new Error("target key identity");
        unique.delete(selected);
        if (unique.has(first) || !unique.has(second)) throw new Error("aliased deletion");
        type Resource = {kind: "target"; target: RenderTarget} | {kind: "count"; count: number};
        const resources = new Set<Resource>([{kind: "target", target: first}, {kind: "count", count: 3}]);
        let seen = 0;
        for (const resource of resources) {
            if (resource.kind === "target") {
                if (resource.target !== selected) throw new Error("tagged target identity");
                seen++;
            } else seen += resource.count;
        }
        function lookup(targets: Map<string, RenderTarget>, key: string): RenderTarget {
            const target = targets.get(key);
            if (!target) throw new Error("missing target");
            return target;
        }
        if (seen !== 4 || lookup(state.targets, "second") !== second)
            throw new Error("shared target return");
        let active: State = {current: first, targets: state.targets};
        const original = active;
        function replaceRecord(): RenderTarget {
            active = {current: first, targets: state.targets};
            return second;
        }
        active.current = replaceRecord();
        if (original.current !== second || active.current !== first)
            throw new Error("retained assignment receiver");
        const bracketOriginal = active;
        active["current"] = replaceRecord();
        if (bracketOriginal.current !== second || active.current !== first)
            throw new Error("retained bracket receiver");
        let nullable: {current: RenderTarget | null} = {current: first};
        const nullableOriginal = nullable;
        function replaceNullable(): RenderTarget {
            nullable = {current: null};
            return second;
        }
        nullable.current = replaceNullable();
        if (nullableOriginal.current !== second || nullable.current !== null)
            throw new Error("retained nullable receiver");
        const keyed: {a: RenderTarget; b: RenderTarget; count: number} = {a: first, b: first, count: 0};
        let key: "a" | "b" = engine.drawCallCount ? "b" : "a";
        function replaceKey(): RenderTarget {
            key = "b";
            return second;
        }
        keyed[key] = replaceKey();
        if (keyed.a !== second || keyed.b !== first)
            throw new Error("retained assignment key");
        let array: RenderTarget[] = [first];
        const originalArray = array;
        function replaceArray(): RenderTarget {
            array = [first];
            return second;
        }
        array[0] = replaceArray();
        if (originalArray[0] !== second || array[0] !== first)
            throw new Error("retained assignment array");
        createRenderTask({rt: lookup(state.targets, "first")}, engine, scene);
        createRenderTask({rt: state.current}, engine, scene);
    `);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const lowered = new RenderTargetLowerer(new LoweringContext()).lower()
        .source;
    runGeneratedProgram(
        tools,
        "stored-render-targets",
        `#define main generated_main
${result.cpp}
#undef main
#include <cassert>
namespace { unsigned int passes = 0; }
namespace bbl {
${cppFunction(lowered, "std::uint32_t render_target_dimension(")}
${cppFunction(lowered, "RenderTargetHandle create_render_target(")}
Engine create_engine(EngineOptions) { return {}; }
Scene create_scene_context(Engine& engine) {
    Scene scene;
    scene.engine = &engine;
    return scene;
}
TaskHandle create_render_task(Engine& engine, Scene& scene, RenderTaskOptions options) {
    assert(scene.engine == &engine);
    assert(options.target.value == passes);
    const auto& target = handle_at(engine.render_targets, options.target);
    assert(target.width == (passes == 0 ? 32u : 48u));
    return {passes++};
}
}
int main() {
    assert(generated_main() == 0);
    assert(passes == 2);
}
`,
    );
});

test("stored render targets require proven attachment signatures for temporal passes", () => {
    const prefix = `
        import {createEngine, createSceneContext, createRenderTarget, createRenderTask,
            createTaaPostProcessTask} from "@babylonjs/lite";
        const engine = await createEngine({});
        const scene = createSceneContext(engine, {defaultRenderTask: false});
        const rt = createRenderTarget({format: engine.format, dFormat: "depth24plus-stencil8", samples: 1, size: engine});
        const targets = new Map<string, typeof rt>([["source", rt]]);
        const stored = targets.get("source")!;
    `;
    const direct = "const source = createRenderTask({rt}, engine, scene);";
    const cached =
        "const source = createRenderTask({rt: stored}, engine, scene);";
    const taa = `createTaaPostProcessTask({sourceTexture: rt, sourceRenderTask: source,
        targetTexture: engine.scRT}, engine, scene);`;
    assert.doesNotThrow(() => compileSource(prefix + cached));
    assert.throws(
        () => compileSource(prefix + cached + taa),
        /engine color format and depth24plus-stencil8/,
    );
    assert.throws(
        () =>
            compileSource(
                prefix +
                    direct +
                    taa.replace("sourceTexture: rt", "sourceTexture: stored"),
            ),
        /proven single-sample source texture/,
    );
});
