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

test("a split counts a test once and a pure call on counted tests as none, and its arm is JavaScript's", (t) => {
    const source = `
import { createEngine, createEffectWrapper, type EngineContext } from "@babylonjs/lite";
interface Surface { label: string; water?: boolean; glass?: boolean; coat?: boolean }
function surfaceWgsl(water: boolean, glass: boolean, coat: boolean): string {
    return \`// \${water} \${glass} \${coat}
@fragment fn effectFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\`;
}
function gathersSnow(water: boolean, glass: boolean): boolean { return !water && !glass; }
function surface(engine: EngineContext, opts: Surface) {
    return createEffectWrapper(engine, {
        name: opts.label,
        fragmentWGSL: surfaceWgsl(opts.water === true, opts.glass === true, opts.coat === true),
        bindings: [{ binding: 0, kind: "uniform", uniformByteLength: 16 }],
    });
}
async function main() {
    const engine = await createEngine(document.createElement("canvas"));
    const flags = JSON.parse("[true,false]") as boolean[];
    const water = flags[0]!;
    const glass = flags[1]!;
    surface(engine, {
        label: "surface",
        ...(water ? { water: true } : {}),
        ...(glass ? { glass: true } : {}),
        ...(gathersSnow(water, glass) ? { coat: true } : {}),
    });
}
main();`;
    const compiled = compileSource(source);
    // Two tests, water and glass: each arm's text is JavaScript's for them.
    assert.equal(
        (compiled.cpp.match(/const bool \w*case_test_\d+/g) ?? []).length,
        2,
    );
    const texts = compiled.manifest.effects.map(
        ({ fragment }) => fragment.split("\n")[0]!,
    );
    assert.deepEqual(
        [...texts].sort(),
        [
            [false, false],
            [false, true],
            [true, false],
            [true, true],
        ]
            .map(([water, glass]) => `// ${water} ${glass} ${!water && !glass}`)
            .sort(),
    );
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required.");
        return;
    }
    runGeneratedProgram(
        native,
        "effect-static-string/deduplicated-tests",
        `#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <cassert>
#include <cstring>
namespace {
const char* texts[] = { ${texts.map((text) => JSON.stringify(text)).join(", ")} };
int creations = 0;
}
namespace bbl {
Engine create_engine(EngineOptions) { return {}; }
EffectWrapperHandle create_effect_wrapper(Engine&, std::uint32_t variant) {
    assert(std::strcmp(texts[variant], "// true false false") == 0);
    ++creations;
    return {variant};
}
}
#define main generated_main
${compiled.cpp}
#undef main
int main() {
    assert(generated_main() == 0);
    assert(creations == 1);
}`,
        { expectedOutput: "" },
    );
});

test("a test that matters only inside one arm of a split joins it, and each arm is JavaScript's", (t) => {
    const source = `
import { createEngine, createEffectWrapper, type EngineContext } from "@babylonjs/lite";
interface Surface { label: string; water?: boolean; glow?: boolean; mask?: boolean }
function surfaceWgsl(water: boolean, mask: boolean): string {
    return \`// \${water} \${mask}
@fragment fn effectFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\`;
}
function surface(engine: EngineContext, opts: Surface) {
    return createEffectWrapper(engine, {
        name: opts.label,
        fragmentWGSL: surfaceWgsl(opts.water === true, opts.mask === true),
        bindings: [{ binding: 0, kind: "uniform", uniformByteLength: 16 }],
    });
}
async function main() {
    const engine = await createEngine(document.createElement("canvas"));
    const flags = JSON.parse("[false,true,true]") as boolean[];
    const water = flags[0]!;
    const glass = flags[1]!;
    const gate = flags[2]!;
    // The glass test changes nothing while the gate is false: it decides
    // the mask only inside the gate's arm.
    surface(engine, {
        label: "surface",
        ...(water ? { water: true } : {}),
        ...(glass ? { glow: true } : gate ? { mask: true } : {}),
    });
}
main();`;
    const compiled = compileSource(source);
    assert.equal(
        (compiled.cpp.match(/const bool \w*case_test_\d+/g) ?? []).length,
        3,
    );
    const texts = compiled.manifest.effects.map(
        ({ fragment }) => fragment.split("\n")[0]!,
    );
    assert.deepEqual(
        [...new Set(texts)].sort(),
        [false, true]
            .flatMap((water) =>
                [false, true].flatMap((glass) =>
                    [false, true].map(
                        (gate) => `// ${water} ${!glass && gate}`,
                    ),
                ),
            )
            .filter((text, index, all) => all.indexOf(text) === index)
            .sort(),
    );
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required.");
        return;
    }
    runGeneratedProgram(
        native,
        "effect-static-string/arm-dependency",
        `#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <cassert>
#include <cstring>
namespace {
const char* texts[] = { ${texts.map((text) => JSON.stringify(text)).join(", ")} };
int creations = 0;
}
namespace bbl {
Engine create_engine(EngineOptions) { return {}; }
EffectWrapperHandle create_effect_wrapper(Engine&, std::uint32_t variant) {
    assert(std::strcmp(texts[variant], "// false false") == 0);
    ++creations;
    return {variant};
}
}
#define main generated_main
${compiled.cpp}
#undef main
int main() {
    assert(generated_main() == 0);
    assert(creations == 1);
}`,
        { expectedOutput: "" },
    );
});

test("a record picked from a constant table splits per distinct row, its booleans read together, and each arm is JavaScript's", (t) => {
    const source = `
import { createEngine, createEffectWrapper, type EngineContext } from "@babylonjs/lite";
type Name = "full" | "lean" | "bare";
interface Profile { readonly shadow: boolean; readonly gloss: boolean; readonly lights: boolean; readonly vertex: boolean }
const PROFILES: Readonly<Record<Name, Profile>> = {
    full: { shadow: true, gloss: true, lights: true, vertex: false },
    lean: { shadow: true, gloss: false, lights: true, vertex: true },
    bare: { shadow: false, gloss: false, lights: false, vertex: false },
};
function profileOf(name: Name): Profile { return PROFILES[name]; }
function resolve(query: string, lights: boolean): Profile {
    if (query === "full" || query === "lean" || query === "bare") return profileOf(query);
    const shipped = profileOf("lean");
    return lights === shipped.lights ? shipped : { ...shipped, lights };
}
function surfaceWgsl(profile: Profile, cache: boolean): string {
    return \`// \${profile.shadow} \${profile.gloss} \${profile.lights} \${profile.vertex} \${cache}
@fragment fn effectFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\`;
}
function surface(engine: EngineContext, opts: { label: string; profile: Profile; cache: boolean }) {
    return createEffectWrapper(engine, {
        name: opts.label,
        fragmentWGSL: surfaceWgsl(opts.profile, opts.cache),
        bindings: [{ binding: 0, kind: "uniform", uniformByteLength: 16 }],
    });
}
async function main() {
    const engine = await createEngine(document.createElement("canvas"));
    const input = JSON.parse('["bare", false, true]') as [string, boolean, boolean];
    const query = input[0];
    const lights = input[1];
    const cache = input[2];
    surface(engine, { label: "surface", profile: resolve(query, lights), cache });
}
main();`;
    const compiled = compileSource(source);
    // The rows the profile can be: each table row, and each with its lights
    // replaced; per row, the cache flag's two texts.
    const rows: (readonly boolean[])[] = [
        [true, true, true, false],
        [true, false, true, true],
        [false, false, false, false],
    ].flatMap((row) => [row, [row[0]!, row[1]!, !row[2], row[3]!]]);
    const texts = compiled.manifest.effects.map(
        ({ fragment }) => fragment.split("\n")[0]!,
    );
    assert.deepEqual(
        [...new Set(texts)].sort(),
        rows
            .flatMap((row) =>
                [false, true].map((cache) => `// ${[...row, cache].join(" ")}`),
            )
            .sort(),
    );
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required.");
        return;
    }
    runGeneratedProgram(
        native,
        "effect-static-string/table-rows",
        `#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <cassert>
#include <cstring>
namespace {
const char* texts[] = { ${texts.map((text) => JSON.stringify(text)).join(", ")} };
int creations = 0;
}
namespace bbl {
Engine create_engine(EngineOptions) { return {}; }
EffectWrapperHandle create_effect_wrapper(Engine&, std::uint32_t variant) {
    assert(std::strcmp(texts[variant], "// false false false false true") == 0);
    ++creations;
    return {variant};
}
}
#define main generated_main
${compiled.cpp}
#undef main
int main() {
    assert(generated_main() == 0);
    assert(creations == 1);
}`,
        { expectedOutput: "" },
    );
});

test("a constant row's arm reads an optional member the row lacks as undefined, as JavaScript does", (t) => {
    const source = `
import { createEngine, createEffectWrapper, type EngineContext } from "@babylonjs/lite";
type Name = "plain" | "tinted";
interface Look { readonly gloss: boolean; readonly tint?: string }
const LOOKS: Readonly<Record<Name, Look>> = {
    plain: { gloss: false },
    tinted: { gloss: true, tint: "warm" },
};
function resolve(query: string): Look {
    return query === "tinted" ? LOOKS["tinted"] : LOOKS["plain"];
}
function surfaceWgsl(look: Look): string {
    return \`// \${look.gloss} \${look.tint ?? "none"}
@fragment fn effectFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\`;
}
function surface(engine: EngineContext, opts: { label: string; look: Look }) {
    return createEffectWrapper(engine, {
        name: opts.label,
        fragmentWGSL: surfaceWgsl(opts.look),
        bindings: [{ binding: 0, kind: "uniform", uniformByteLength: 16 }],
    });
}
async function main() {
    const engine = await createEngine(document.createElement("canvas"));
    const query = (JSON.parse('["plain"]') as string[])[0]!;
    surface(engine, { label: "surface", look: resolve(query) });
}
main();`;
    const compiled = compileSource(source);
    const texts = compiled.manifest.effects.map(
        ({ fragment }) => fragment.split("\n")[0]!,
    );
    assert.deepEqual([...new Set(texts)].sort(), [
        "// false none",
        "// true warm",
    ]);
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required.");
        return;
    }
    runGeneratedProgram(
        native,
        "effect-static-string/row-lacks-member",
        `#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <cassert>
#include <cstring>
namespace {
const char* texts[] = { ${texts.map((text) => JSON.stringify(text)).join(", ")} };
int creations = 0;
}
namespace bbl {
Engine create_engine(EngineOptions) { return {}; }
EffectWrapperHandle create_effect_wrapper(Engine&, std::uint32_t variant) {
    assert(std::strcmp(texts[variant], "// false none") == 0);
    ++creations;
    return {variant};
}
}
#define main generated_main
${compiled.cpp}
#undef main
int main() {
    assert(generated_main() == 0);
    assert(creations == 1);
}`,
        { expectedOutput: "" },
    );
});

test("a run-time record no constant bounds splits per combination of its boolean members, read from the record itself", (t) => {
    const source = `
import { createEngine, createEffectWrapper, type EngineContext } from "@babylonjs/lite";
interface Profile { readonly shadow: boolean; readonly gloss: boolean; readonly lights: boolean; readonly vertex: boolean }
function surfaceWgsl(profile: Profile, cache: boolean): string {
    return \`// \${profile.shadow} \${profile.gloss} \${profile.lights} \${profile.vertex} \${cache}
@fragment fn effectFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\`;
}
function surface(engine: EngineContext, opts: { label: string; profile: Profile; cache: boolean }) {
    return createEffectWrapper(engine, {
        name: opts.label,
        fragmentWGSL: surfaceWgsl(opts.profile, opts.cache),
        bindings: [{ binding: 0, kind: "uniform", uniformByteLength: 16 }],
    });
}
async function main() {
    const engine = await createEngine(document.createElement("canvas"));
    const input = JSON.parse("[1, true]") as [number, boolean];
    const index = input[0];
    const cache = input[1];
    const profiles: Profile[] = [
        { shadow: true, gloss: false, lights: true, vertex: false },
        { shadow: false, gloss: true, lights: false, vertex: true },
    ];
    surface(engine, { label: "surface", profile: profiles[index]!, cache });
}
main();`;
    const compiled = compileSource(source);
    const texts = compiled.manifest.effects.map(
        ({ fragment }) => fragment.split("\n")[0]!,
    );
    // Every combination of the four members, per cache flag.
    const all = Array.from(
        { length: 32 },
        (_, bits) =>
            `// ${[0, 1, 2, 3, 4].map((bit) => (bits & (1 << bit)) !== 0).join(" ")}`,
    );
    assert.deepEqual([...new Set(texts)].sort(), [...all].sort());
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required.");
        return;
    }
    runGeneratedProgram(
        native,
        "effect-static-string/member-rows",
        `#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <cassert>
#include <cstring>
namespace {
const char* texts[] = { ${texts.map((text) => JSON.stringify(text)).join(", ")} };
int creations = 0;
}
namespace bbl {
Engine create_engine(EngineOptions) { return {}; }
EffectWrapperHandle create_effect_wrapper(Engine&, std::uint32_t variant) {
    assert(std::strcmp(texts[variant], "// false true false true true") == 0);
    ++creations;
    return {variant};
}
}
#define main generated_main
${compiled.cpp}
#undef main
int main() {
    assert(generated_main() == 0);
    assert(creations == 1);
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
