import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const factory = `
import { createEngine, createEffectWrapper, setEffectUniforms, type EngineContext } from "@babylonjs/lite";
type Channels = "scalar" | "color" | "scene-color";
interface Options {
    label: string;
    channels?: Channels;
    radius?: number;
    denoise?: boolean;
    changed?: () => boolean;
}
function blendWgsl(channels: Channels, jitter = false, denoise = false): string {
    const weights = [0.25, 0.5].map(value => value.toFixed(2)).join(", ");
    return \`// \${channels} \${jitter} \${denoise} \${weights}
@fragment fn effectFragment() -> @location(0) vec4<f32> { return vec4<f32>(\${jitter ? "0.5" : "1.0"}); }\`;
}
function setup(engine: EngineContext, opts: Options) {
    const channels = opts.channels ?? "scalar";
    const blendWGSL = blendWgsl(channels, (opts.radius ?? 0) > 0, opts.denoise === true);
    const effect = createEffectWrapper(engine, {
        name: \`\${opts.label}-blend\`,
        fragmentWGSL: blendWGSL,
        bindings: [{ binding: 0, kind: "uniform", uniformByteLength: 16 }],
    });
    // A call on the options object may write its slots, but occurs only
    // after the required-text read, when this returned callback runs.
    return { update: (value: number) => {
        opts.changed?.();
        setEffectUniforms(effect, new Float32Array([value, 0, 0, 0]));
    } };
}
`;

function program(body: string): string {
    return `${factory}
async function main() {
    const engine = await createEngine(document.createElement("canvas"));
    ${body}
}
main();`;
}

test("effect builder inputs specialize four conditional option records", () => {
    const compiled = compileSource(
        program(`
        const enabled = Math.random() > 0.5;
        const a = enabled ? setup(engine, { label: "a", channels: "scene-color" }) : null;
        const b = enabled ? setup(engine, { label: "b" }) : null;
        const c = enabled ? setup(engine, { label: "c", radius: Math.random() }) : null;
        const d = enabled ? setup(engine, { label: "d", channels: "color", denoise: true }) : null;
        `),
    );
    assert.deepEqual(
        compiled.manifest.effects.map(({ name, fragment }) => [
            name,
            fragment.split("\n")[0],
        ]),
        [
            ["a-blend", "// scene-color false false 0.25, 0.50"],
            ["b-blend", "// scalar false false 0.25, 0.50"],
            ["c-blend", "// scalar true false 0.25, 0.50"],
            ["c-blend", "// scalar false false 0.25, 0.50"],
            ["d-blend", "// color false true 0.25, 0.50"],
        ],
    );
    assert.equal(
        (compiled.cpp.match(/const bool \w*case_test_\d+/g) ?? []).length,
        1,
    );
});

test("effect builder finite predicates select native variants without repeating arguments", (t) => {
    const compiled = compileSource(
        program(`
        let reads = 0;
        let callbacks = 0;
        function radius(value: number): number { reads++; return value; }
        const rows = JSON.parse("[-2,0,3]") as number[];
        ${[0, 1, 2]
            .map(
                (index) => `{
            const value = rows[${index}]!;
            const enabled = value > -10;
            const handle = enabled ? setup(engine, {
                label: "native", radius: radius(value),
                changed: () => { callbacks++; return false; },
            }) : null;
            if (handle) handle.update(value);
            const skipped = !enabled ? setup(engine, { label: "skipped", radius: radius(value) }) : null;
            if (skipped) throw new Error("unselected factory ran");
        }`,
            )
            .join("\n")}
        if (reads !== 3 || callbacks !== 3) throw new Error("argument or callback repeated");
        `),
    );
    const variants = compiled.manifest.effects
        .map(({ name, fragment }) =>
            name === "native-blend"
                ? fragment.startsWith("// scalar true ")
                    ? 1
                    : 0
                : -1,
        )
        .join(", ");
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required.");
        return;
    }
    runGeneratedProgram(
        native,
        "effect-static-string/finite-predicates",
        `#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <cassert>
namespace {
constexpr int variants[] = { ${variants} };
int creations = 0;
int updates = 0;
bbl::Engine* owner = nullptr;
}
namespace bbl {
Engine create_engine(EngineOptions) { return {}; }
EffectWrapperHandle create_effect_wrapper(Engine& engine, std::uint32_t variant) {
    assert(variants[variant] == (creations == 2 ? 1 : 0));
    owner = &engine;
    ++creations;
    return {variant};
}
void set_effect_uniforms(Engine& engine, EffectWrapperHandle effect, const js::F32Array& data) {
    assert(&engine == owner);
    assert(variants[effect.value] == (data[0] > 0 ? 1 : 0));
    ++updates;
}
}
#define main generated_main
${compiled.cpp}
#undef main
int main() {
    assert(generated_main() == 0);
    assert(creations == 3 && updates == 3);
}`,
        { expectedOutput: "" },
    );
});

test("effect builder replay refuses changed inputs and unbounded shader text", () => {
    const source = program(`
        setup(engine, { label: "refuse", radius: Math.random() });
    `);
    for (const changed of [
        source.replace("const effect =", "opts.radius = 7; const effect ="),
        source.replace("const effect =", "opts.changed?.(); const effect ="),
        source
            .replace("const effect =", "change(); const effect =")
            .replace(
                'const channels = opts.channels ?? "scalar";',
                'function change(): void { opts.radius = 7; } const channels = opts.channels ?? "scalar";',
            ),
        source.replace(
            'setup(engine, { label: "refuse", radius: Math.random() });',
            'let reads = 0; setup(engine, { label: "refuse", get radius() { return reads++; } });',
        ),
        source
            .replace("(opts.radius ?? 0) > 0", "(opts.radius ?? 0)")
            .replace("jitter = false", "jitter = 0")
            .replace('${jitter ? "0.5" : "1.0"}', "${jitter.toFixed(2)}"),
    ]) {
        assert.throws(
            () => compileSource(changed),
            /Expected a string literal|without a static string/,
        );
    }
});
