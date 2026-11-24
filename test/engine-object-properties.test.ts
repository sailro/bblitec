import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

/** A factory making a fresh object, as the pin's do: `{ ...props }`. */
const fresh = (props?: object): object => ({ ...props });

/** JavaScript's own run of `program`, each of `factories` making a fresh object. */
async function runInJavaScript(
    program: string,
    factories: readonly string[],
): Promise<void> {
    const realm: { finished?: Promise<void> } = {};
    runInNewContext(
        ts.transpileModule(
            program.replace("void main();", "realm.finished = main();"),
            {
                compilerOptions: {
                    target: ts.ScriptTarget.ESNext,
                    module: ts.ModuleKind.CommonJS,
                },
            },
        ).outputText,
        {
            exports: {},
            realm,
            document: { getElementById: () => ({}) },
            require: () => ({
                createEngine: async () => ({}),
                // The pin's: an `async` installer settling after its module hop.
                enableMaterialTracking: async () => {
                    await Promise.resolve();
                },
                wgsl: (parts: TemplateStringsArray) => parts.join(""),
                ...Object.fromEntries(factories.map((name) => [name, fresh])),
            }),
        },
    );
    await realm.finished;
}

/**
 * The generated program run natively over factories making a record each:
 * a ShaderMaterial's, and a PBR one's with the scene factory's lane (the
 * creation site keeps the property itself). It throws where its result is
 * not JavaScript's.
 */
function runNatively(t: TestContext, name: string, cpp: string): void {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(
        tools,
        `engine-object-properties/${name}`,
        `#define main generated_main
${cpp}
#undef main
namespace bbl {
Engine create_engine(EngineOptions) { return {}; }
MaterialHandle create_shader_material(Engine& engine, std::uint32_t) {
    engine.materials.emplace_back().shader_material = true;
    return MaterialHandle{static_cast<std::uint32_t>(engine.materials.size() - 1)};
}
MaterialHandle create_pbr_material(Engine& engine, PbrMaterialOptions options) {
    engine.materials.emplace_back().environment_intensity = options.environment_intensity;
    return MaterialHandle{static_cast<std::uint32_t>(engine.materials.size() - 1)};
}
} // namespace bbl
int main() { return generated_main(); }
`,
        { expectedOutput: "", timeoutMs: 20000 },
    );
}

// ShaderMaterials held as `unknown` and read back through a view the pin
// does not declare: each keeps the number the program adds to it, by its
// identity, as JavaScript does.
const addedProgram = `
import { createEngine, createShaderMaterial, wgsl } from "@babylonjs/lite";
type Held = { material?: unknown };
type Tinted = { level?: number };
const shaderMaterial = (name: string) =>
    createShaderMaterial({
        name,
        vertexSource: wgsl\`@vertex fn main(@location(0) position: vec3<f32>) -> @builtin(position) vec4<f32> { return vec4<f32>(position, 1.0); }\`,
        fragmentSource: wgsl\`@fragment fn main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\`,
        attributes: ["position"],
        uniforms: ["worldViewProjection"],
    });
function collect(held: readonly Held[]): string {
    const seen = new Set<object>();
    const out: string[] = [];
    for (const entry of held) {
        const material = entry.material as Tinted | undefined;
        if (!material || seen.has(material)) continue;
        seen.add(material);
        out.push(String("level" in material), String(material.level ?? -1));
        material.level = seen.size * 10;
        material.level += 1;
    }
    for (const entry of held)
        if (entry.material) out.push(String((entry.material as Tinted).level));
    const first = held[0]!.material as Tinted;
    out.push(String("level" in first));
    delete first.level;
    out.push(String("level" in first), String(first.level));
    first.level ??= 7;
    first.level &&= first.level + 1;
    out.push(String(first.level));
    return out.join();
}
async function main(): Promise<void> {
    await createEngine({});
    const a = shaderMaterial("a");
    const b = shaderMaterial("b");
    const result = collect([{ material: a }, { material: b }, { material: a }, {}]);
    if (result !== "false,-1,false,-1,11,21,11,true,false,undefined,8") throw new Error("properties " + result);
}
void main();
`;

test("a number a program adds to ShaderMaterials is each material's own, written, read, tested and deleted as in JavaScript", async (t) => {
    await runInJavaScript(addedProgram, ["createShaderMaterial"]);
    const { cpp } = compileSource(addedProgram);
    // One storage for the property, keyed by each material's identity.
    assert.match(
        cpp,
        /bbl::EngineObjectProperty<bbl::js::Nullable<double>>& (v_\w+object_property_\d+)\(bbl::Engine& engine\)/,
    );
    assert.match(cpp, /\.contains\(bbl::engine_object_identity\(/);
    assert.match(cpp, /\.erase\(bbl::engine_object_identity\(/);
    runNatively(t, "added-number", cpp);
});

// Materials of two families collected through one view, as a day/night
// dimmer does: each keeps its own `environmentIntensity`, absent until
// written, the PBR one reaching its record's writer lane.
const intensityProgram = `
import { createEngine, createPbrMaterial, createShaderMaterial, wgsl } from "@babylonjs/lite";
type Held = { material?: unknown };
function collect(held: readonly Held[]): string {
    const seen = new Set<object>();
    const out: string[] = [];
    for (const m of held) {
        const mat = m.material as { environmentIntensity?: number } | undefined;
        if (mat && typeof mat === "object" && !seen.has(mat)) {
            seen.add(mat);
            const base = mat.environmentIntensity ?? 1;
            mat.environmentIntensity = base;
            mat.environmentIntensity *= 0.5;
            out.push(String(mat.environmentIntensity));
        }
    }
    return out.join();
}
async function main(): Promise<void> {
    await createEngine({});
    const shader = createShaderMaterial({ name: "s", vertexSource: wgsl\`@vertex fn main(@location(0) position: vec3<f32>) -> @builtin(position) vec4<f32> { return vec4<f32>(position, 1.0); }\`, fragmentSource: wgsl\`@fragment fn main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\`, attributes: ["position"], uniforms: ["worldViewProjection"] });
    const pbr = createPbrMaterial({ environmentIntensity: 0.75 });
    const plain = createPbrMaterial();
    const result = collect([{ material: shader }, { material: pbr }, { material: plain }, { material: pbr }]);
    if (result !== "0.5,0.375,0.5") throw new Error("intensities " + result);
}
void main();
`;

test("a material of a family decided at run time keeps its own environmentIntensity through a view, as in JavaScript", async (t) => {
    await runInJavaScript(intensityProgram, [
        "createShaderMaterial",
        "createPbrMaterial",
    ]);
    const { cpp } = compileSource(intensityProgram);
    assert.match(cpp, /\.source_environment_intensity = 0\.75;/);
    runNatively(t, "environment-intensity", cpp);
});

// The dimmer keeping each material it collects in a record whose field is
// typed by the view: the field holds the material itself, so a later write
// through it reaches the same object, and so does a property the program
// adds through it.
const trackedProgram = `
import { createEngine, createPbrMaterial, createShaderMaterial, wgsl } from "@babylonjs/lite";
type Held = { material?: unknown };
type Lit = { environmentIntensity?: number; level?: number };
function collect(held: readonly Held[]): string {
    const seen = new Set<object>();
    const tracked: { mat: Lit; base: number }[] = [];
    for (const m of held) {
        const mat = m.material as Lit | undefined;
        if (mat && typeof mat === "object" && !seen.has(mat)) {
            seen.add(mat);
            const base = mat.environmentIntensity ?? 1;
            mat.environmentIntensity = base;
            tracked.push({ mat, base });
        }
    }
    for (const e of tracked) {
        e.mat.environmentIntensity = e.base * 0.5;
        e.mat.level = e.base * 10;
    }
    const again = held[1]!.material as Lit;
    return [tracked.map((e) => String(e.mat.environmentIntensity) + ":" + String(e.mat.level)).join(), String(again.environmentIntensity), String(again.level)].join(";");
}
async function main(): Promise<void> {
    await createEngine({});
    const shader = createShaderMaterial({ name: "s", vertexSource: wgsl\`@vertex fn main(@location(0) position: vec3<f32>) -> @builtin(position) vec4<f32> { return vec4<f32>(position, 1.0); }\`, fragmentSource: wgsl\`@fragment fn main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\`, attributes: ["position"], uniforms: ["worldViewProjection"] });
    const pbr = createPbrMaterial({ environmentIntensity: 0.75 });
    const plain = createPbrMaterial();
    const result = collect([{ material: shader }, { material: pbr }, { material: plain }, { material: pbr }]);
    if (result !== "0.5:10,0.375:7.5,0.5:10;0.375;7.5") throw new Error("tracked " + result);
}
void main();
`;

test("a record field typed by a view holds the material written to it, the same object as in JavaScript", async (t) => {
    await runInJavaScript(trackedProgram, [
        "createShaderMaterial",
        "createPbrMaterial",
    ]);
    const { cpp } = compileSource(trackedProgram);
    // The field keeps the material and its engine, not a record of the view.
    assert.match(
        cpp,
        /struct \w+ \{\s*std::pair<bbl::StoredEngine, bbl::MaterialHandle> mat;/,
    );
    runNatively(t, "view-field", cpp);
});

// The dimmer's tracking: each collected material's `enableMaterialTracking`
// promise, mapped into an array `Promise.all` waits on. An owned promise
// settles in a later microtask, so the array holds the promises themselves,
// in the application realm.
const trackingProgram = `
import { createEngine, createShaderMaterial, enableMaterialTracking, wgsl } from "@babylonjs/lite";
async function main(): Promise<void> {
    await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
    const make = (name: string) => createShaderMaterial({ name, vertexSource: wgsl\`@vertex fn main(@location(0) position: vec3<f32>) -> @builtin(position) vec4<f32> { return vec4<f32>(position, 1.0); }\`, fragmentSource: wgsl\`@fragment fn main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\`, attributes: ["position"], uniforms: ["worldViewProjection"] });
    const tracked: { mat: { environmentIntensity?: number }; base: number }[] = [];
    for (const name of ["a", "b"]) {
        const mat = make(name) as { environmentIntensity?: number };
        tracked.push({ mat, base: 1 });
    }
    let settled = false;
    const all = Promise.all(tracked.map((e) => enableMaterialTracking(e.mat as never))).then(() => {
        settled = true;
    });
    if (settled) throw new Error("settled before its microtasks");
    await all;
    if (!settled) throw new Error("tracking never settled");
}
void main();
`;

test("an owned promise a callback maps each element to is held as that promise, which settles later as in JavaScript", async () => {
    await runInJavaScript(trackingProgram, ["createShaderMaterial"]);
    const { cpp, manifest } = compileSource(trackingProgram);
    // The program runs in the application realm, whose queue settles them.
    assert.ok(manifest.features.includes("platform:workers"));
    assert.match(
        cpp,
        /bbl::js::Array<bbl::js::Promise<bbl::js::PromiseVoid>> \w+;/,
    );
    assert.match(cpp, /bbl::js::promise_all\(/);
    // The dimmer's own spelling, the promise discarded: the same storage.
    const discarded = compileSource(
        trackingProgram
            .replace(
                /const all = [^;]*;\n {4}\}\);/,
                "void Promise.all(tracked.map((e) => enableMaterialTracking(e.mat as never)));",
            )
            .replace(/ {4}if \(settled\)[^\n]*\n {4}await all;\n[^\n]*\n/, ""),
    );
    assert.ok(discarded.manifest.features.includes("platform:workers"));
    assert.match(
        discarded.cpp,
        /bbl::js::Array<bbl::js::Promise<bbl::js::PromiseVoid>> \w+;/,
    );
});

test("a PBR material's own member written through the same view reaches its record", () => {
    const { cpp } = compileSource(`
import { createEngine, createPbrMaterial } from "@babylonjs/lite";
async function main(): Promise<void> {
    await createEngine({});
    const pbr = createPbrMaterial();
    (pbr as { environmentIntensity?: number; level?: number }).environmentIntensity = 0.25;
    (pbr as { environmentIntensity?: number; level?: number }).level = 2;
}
void main();
`);
    // Nothing reads the number back, so the record keeps only the writer's
    // float: the store is the constant it was.
    assert.match(cpp, /\.environment_intensity = 0\.25f;/);
    assert.doesNotMatch(cpp, /source_environment_intensity/);
    assert.doesNotMatch(cpp, /environmentIntensity/);
    // The program's own `level` is the material's added property.
    assert.match(
        cpp,
        /\[bbl::engine_object_identity\(v_\w*pbr\)\] = bbl::js::Nullable<double>\{2\.0\};/,
    );
});

test("a number a program adds to a mesh through an intersection is stored and read back", () => {
    const { cpp } = compileSource(`
import { createEngine, createGround, type Mesh } from "@babylonjs/lite";
async function main(): Promise<void> {
    const engine = await createEngine({});
    const ground = createGround(engine, { width: 2, height: 2 });
    (ground as Mesh & { integrationTag?: number }).integrationTag = 7;
    localStorage.setItem("tag", String((ground as Mesh & { integrationTag?: number }).integrationTag));
}
void main();
`);
    assert.match(
        cpp,
        /\[bbl::engine_object_identity\(v_\w*ground\)\] = bbl::js::Nullable<double>\{7\.0\};/,
    );
    assert.match(
        cpp,
        /bbl::engine_object_property_value\(bblscene::v_\w+object_property_\d+\(v_\w*engine\), bbl::engine_object_identity\(v_\w*ground\)\)/,
    );
});

test("a material whose family is decided at run time refuses a member one family declares", () => {
    assert.throws(
        () =>
            compileSource(`
import { createEngine, createMeshFromData, type Mesh } from "@babylonjs/lite";
async function main(): Promise<void> {
    const engine = await createEngine({});
    const meshes: Mesh[] = [createMeshFromData(engine, "m", new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), new Uint32Array([0, 1, 2]))];
    for (const m of meshes as readonly { material?: unknown }[]) {
        const mat = m.material as { metallicFactor?: number } | undefined;
        if (mat) localStorage.setItem("e", String(mat.metallicFactor ?? 1));
    }
}
void main();
`),
        /'metallicFactor' is the pin's own member of a pbr material, and a property the program adds to any other; this material's family is decided at run time/,
    );
});
