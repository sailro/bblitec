import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { CompileError, compileSource } from "../src/compiler.js";
import { labDeployment, pinnedAssetUrl } from "./compiler-fixtures.js";

test("compiles pinned scene 2 directional light colors", () => {
    const sourcePath = "corpus/babylon-lite/lab/lite/src/lite/scene2.ts";
    const result = compileSource(readFileSync(resolve(sourcePath), "utf8"), {
        fileName: sourcePath,
    });

    assert.ok(result.manifest.features.includes("light:directional"));
    assert.ok(result.manifest.features.includes("material:standard"));
    assert.match(
        result.cpp,
        /\.lights, v_light\)\.diffuse_color = bbl::Color3\{1\.0f, 0\.0f, 0\.0f\}/,
    );
    assert.match(
        result.cpp,
        /\.lights, v_light\)\.specular_color = bbl::Color3\{0\.0f, 1\.0f, 0\.0f\}/,
    );
});

test("selects a loop material before invoking its shared helper", () => {
    // The integer counter chooses the material at the call site. The shared
    // body captures that selected handle and receives the counter as x.
    const result = compileSource(`
        import {
            addToScene,
            createBox,
            createEngine,
            createSceneContext,
            createStandardMaterial,
        } from "@babylonjs/lite";
        import type { EngineContext, Mesh, StandardMaterialProps } from "@babylonjs/lite";

        function createBar(engine: EngineContext, material: StandardMaterialProps, x: number): Mesh {
            const bar = createBox(engine, 1);
            bar.position.x = x;
            bar.material = material;
            return bar;
        }

        async function main(): Promise<void> {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const scene = createSceneContext(engine);
            const cyan = createStandardMaterial();
            const white = createStandardMaterial();
            for (let i = 0; i < 24; i++) {
                addToScene(scene, createBar(engine, i % 3 === 0 ? cyan : white, i));
            }
        }
    `);

    assert.match(result.cpp, /std::int64_t v_\w+_i = 0;/);
    const selected =
        /auto (v_bblite_resource_argument_\d+) = \(std::fmod\(static_cast<double>\((v_\w+_i)\), 3\.0\) == 0\.0 \? v_cyan : v_white\);/.exec(
            result.cpp,
        );
    assert.ok(selected);
    const called = new RegExp(
        `auto (v_bblite_shared_result_\\d+) = bbl::js::make_closure\\(bblscene::\\w+\\{v_engine, ${selected[1]}\\}, bblscene::\\w+\\)\\(static_cast<double>\\(${selected[2]}\\)\\);`,
    ).exec(result.cpp);
    assert.ok(called && selected.index < called.index);
    assert.equal((result.cpp.match(/std::fmod\(/g) ?? []).length, 1);
    assert.match(
        result.cpp,
        /std::remove_reference_t<bbl::MaterialHandle>& capture\d+;/,
    );
    assert.match(
        result.cpp,
        new RegExp(
            `auto& ${selected[1]} = v_bblite_environment_\\d+\\.capture\\d+;`,
        ),
    );
    assert.match(
        result.cpp,
        new RegExp(
            `bbl::set_mesh_material\\(v_engine, \\w+, ${selected[1]}\\);`,
        ),
    );
    assert.ok(
        result.cpp.includes(
            `bbl::add_to_scene(v_scene, (${called[1]}).second);`,
        ),
    );
});

test("compiles pinned Standard material morph targets", () => {
    const sourcePath = "corpus/babylon-lite/lab/lite/src/lite/scene252.ts";
    const result = compileSource(readFileSync(resolve(sourcePath), "utf8"), {
        fileName: sourcePath,
    });

    assert.deepEqual(result.manifest.features, [
        "core",
        "backend:sdl",
        "camera:arc-rotate",
        "light:directional",
        "material:standard",
        "mesh:morph-targets",
        "mesh:sphere",
        "renderer:scene",
    ]);
    assert.match(
        result.cpp,
        /create_sphere_data\(bbl::SphereOptions\{32u, 1\.0, 1\.0, 1\.0\}\)/,
    );
    assert.match(
        result.cpp,
        /attach_morph_target\([^;]*v_deltas, \{\}, static_cast<float>\(std::get<0>\(\*\w+_scalars_\d+\)\), 1\.0f\)/,
    );
    assert.match(
        result.cpp,
        /const double \w+_vertexCount_\d+ = static_cast<double>\([^;]+\.vertex_count\);/,
    );
    assert.ok(
        result.manifest.generatedSources.includes(
            "upstream/src/mesh_factories.cpp",
        ),
    );
});

test("rejects multiple direct morph targets", () => {
    assert.throws(
        () =>
            compileSource(`
                import {
                    createEngine,
                    createMorphTargets,
                } from "@babylonjs/lite";
                async function main(): Promise<void> {
                    const engine = await createEngine({});
                    const positions = new Float32Array(9);
                    createMorphTargets(
                        engine,
                        [
                            { positions, normals: null },
                            { positions, normals: null },
                        ],
                        3,
                        [1, 0],
                    );
                }
            `),
        /Direct createMorphTargets currently supports exactly one target/,
    );
});

test("updates weights through a named direct morph binding", () => {
    const result = compileSource(`
        import {
            createEngine,
            createMorphTargets,
            createSphere,
            setMorphTargetWeights,
        } from "@babylonjs/lite";
        async function main(): Promise<void> {
            const engine = await createEngine({});
            const sphere = createSphere(engine, {
                segments: 3,
            });
            const positions = new Float32Array(198);
            const morph = createMorphTargets(
                engine,
                [{ positions, normals: null }],
                66,
                [0],
            );
            sphere.morphTargets = morph;
            const weights = new Float32Array([1]);
            setMorphTargetWeights(engine, morph, weights);
        }
    `);

    assert.match(
        result.cpp,
        /attach_morph_target\([^;]*v_sphere[^;]*v_positions[^;]*66\.0f, 0\.0f\)/,
    );
    assert.match(
        result.cpp,
        /set_morph_target_weights\([^;]*v_sphere, v_weights\)/,
    );
    assert.doesNotMatch(result.cpp, /auto v_morph =\s*;/);
});

test("materializes an inferred array mutated through a local alias", () => {
    const result = compileSource(`
        const values = [0];
        const alias = values;
        alias.push(4);
        const selected = values[1];
    `);

    const values = result.cpp.match(/bbl::js::Array<double> (v_values) =/);
    assert.ok(values);
    assert.match(
        result.cpp,
        new RegExp(`bbl::js::Array<double>& v_alias = ${values[1]}`),
    );
    assert.match(result.cpp, /v_alias\.push_back\(4\.0\)/);
});

test("materializes an inferred array before a runtime element read", () => {
    const result = compileSource(`
        interface Point { x: number }
        const source: Point[] = [{ x: 1 }, { x: 2 }, { x: 3 }];
        const i = Math.floor(Math.random() * 3);
        const triplet = [source[0]!, source[1]!, source[2]!];
        const selected = triplet[i]!;
        selected.x = 9;
    `);

    assert.match(result.cpp, /bbl::js::Array<bblscene::Point> v_triplet/);
    // A runtime index the compiler cannot prove in bounds reads through
    // the checked accessor carrying the access's source location.
    assert.match(
        result.cpp,
        /bbl::js::array_index_checked\(v_triplet, v_i, "[^"]+:\d+:\d+"\)/,
    );
    assert.equal((result.cpp.match(/bbl::js::random_js\(\)/g) ?? []).length, 1);
});

test("materializes an inferred array an element increment mutates", () => {
    // `arr[0]++` writes without a binary assignment node, so the mutation
    // walk needs its own increment clause; without one the array stays a
    // folded constant and the write vanishes.
    const result = compileSource(`
        const source = [1, 2, 3];
        const alias = source;
        alias[0]++;
        const first = alias[0];
        console.log(first);
    `);

    assert.match(result.cpp, /bbl::js::Array<double> v_source/);
    assert.match(result.cpp, /array_index_write\(v_alias/);
    assert.match(result.cpp, /\)\+\+;/);
});

test("materializes mutable intersection-typed object locals", () => {
    const result = compileSource(`
        interface Contacts {
            grounded: boolean;
            wall: -1 | 0 | 1;
        }
        function move(): { vx: number } & Contacts {
            const result: { vx: number } & Contacts = {
                vx: 2,
                grounded: false,
                wall: 0,
            };
            result.grounded = true;
            result.wall = 1;
            return result;
        }
        const moved = move();
    `);

    assert.match(result.cpp, /->grounded = true;/);
    assert.match(result.cpp, /->wall = 1\.0;/);
    assert.doesNotMatch(result.cpp, /false = true|0\.0 =/);
});

test("materializes runtime-valued static maps as native arrays", () => {
    const result = compileSource(`
        let offset = 2;
        const mapped = ["a", "b"].map((_, index) => offset + index);
        const picked = mapped[Math.floor(Math.random() * mapped.length)]!;
        let current = [1, 2, 3];
        function replace(): number {
            current = [4];
            return 0;
        }
        const first = current[replace()]!;
    `);

    assert.match(
        result.cpp,
        /bbl::js::Array<double> v_mapped = bbl::js::Array<double>\{/,
    );
    // An index that runs code but cannot rebind the array reads it in place;
    // one that may rebind it reads the array it evaluated first.
    assert.match(
        result.cpp,
        /double v_picked = bbl::js::array_index_checked\(v_mapped, /,
    );
    assert.match(
        result.cpp,
        /auto (v_bblite_indexed_array_\d+) = v_current;[\s\S]*bbl::js::array_index_checked\(\1, /,
    );
});

test("materializes a numeric Record for dynamic optional lookup", () => {
    const result = compileSource(`
        interface Definition { enabled: boolean; weight: number; }
        const definitions: Record<number, Definition> = {
            1: { enabled: true, weight: 2 },
            7: { enabled: false, weight: 4 },
        };
        function lookup(key: number): Definition | undefined {
            return definitions[key];
        }
        let key = 7;
        const definition = lookup(key);
    `);

    assert.match(
        result.cpp,
        /bbl::js::Dictionary<double, bblscene::Definition> v_definitions\b/,
    );
    assert.match(result.cpp, /\.get_owned\(v_\w*key\)/);
});

test("materializes Object.values from a closed Record", () => {
    const result = compileSource(`
        type Area = "one" | "two";
        interface Cell { value: number; }
        function main() {
            const cells: Record<Area, Cell> = {
                one: { value: 1 },
                two: { value: 2 },
            };
            const values = Object.values(cells);
        }
    `);

    assert.match(result.cpp, /\.begin\(\), .*\.end\(\)/);
});

test("materializes Object.keys from a compile-time record", () => {
    const result = compileSource(`
        function main() {
            const cells = {
                one: { value: 1 },
                two: { value: 2 },
            };
            const keys = Object.keys(cells);
        }
    `);

    assert.match(result.cpp, /Array<std::string>\{"one", "two"\}/);
});

test("materializes an iterable spread as a native array", () => {
    const result = compileSource(`
        const sets: Set<number>[] = [new Set<number>([1, 2])];
        const arrays = sets.map((set) => [...set]);
        const first = arrays[0]![0]!;
    `);

    assert.match(result.cpp, /bbl::js::array_from_iterable<double>\(/);
});

test("materializes a constructor-assigned resource field once", () => {
    const result = compileSource(`
        import {
            createBox,
            createEngine,
            createStandardMaterial,
        } from "@babylonjs/lite";
        class Painter {
            private material: StandardMaterial;
            constructor() {
                this.material = createStandardMaterial();
            }
            paint(mesh: Mesh): void {
                mesh.material = this.material;
            }
        }
        async function main(): Promise<void> {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const painter = new Painter();
            painter.paint(createBox(engine, 1));
            painter.paint(createBox(engine, 2));
        }
        main();
    `);

    assert.equal(result.cpp.match(/bbl::create_standard_material/g)?.length, 1);
});

test("materializes a constant number array with double elements", () => {
    // The tuple's own element text is a float literal; widening one
    // back to double does not always give the value the needle holds.
    const result = compileSource(`
        const xs = [0.1, 0.2];
        let needle = 0.2;
        const found = xs.indexOf(needle);
    `);
    assert.match(
        result.cpp,
        /inline const std::array<double, 2> xs\{0\.1, 0\.2\}/,
    );
    assert.match(result.cpp, /array_index_of\(bblscene::xs, v_needle\)/);
});

test("rebinds a nullable material cache entry from its factory", () => {
    const result = compileSource(`
        import {
            createEngine,
            createStandardMaterial,
            type StandardMaterialProps,
        } from "@babylonjs/lite";
        await createEngine({});
        class MaterialCache {
            private material: StandardMaterialProps | undefined;
            materialFor(): StandardMaterialProps {
                let material = this.material;
                if (!material) {
                    material = createStandardMaterial();
                    this.material = material;
                }
                return material;
            }
        }
        const cache = new MaterialCache();
        const material = cache.materialFor();
    `);

    const material = result.cpp.match(
        /std::optional<std::pair<bbl::StoredEngine, bbl::MaterialHandle>> (v_fn\d+_material) = [^\n]+\.to_optional\(\);/,
    );
    assert.ok(material);
    const creation = result.cpp.match(
        new RegExp(
            String.raw`if \(!\(${material[1]}\.has_value\(\)\)\) \{\s*${material[1]} = bbl::js::Nullable<std::pair<bbl::StoredEngine, bbl::MaterialHandle>>\{std::pair<bbl::StoredEngine, bbl::MaterialHandle>\{bbl::StoredEngine\{(\w+)\}, bbl::create_standard_material\(\1\)\}\}\.to_optional\(\);`,
        ),
    );
    assert.ok(creation);
    assert.equal(
        (result.cpp.match(/bbl::create_standard_material\(/g) ?? []).length,
        1,
    );
    const cacheStore = result.cpp.match(
        new RegExp(
            String.raw`\(\*v_bblite_class_field_material_\d+\) = [^\n]+\{\(\*${material[1]}\)\}[^\n]+\.to_optional\(\);`,
        ),
    );
    assert.ok(cacheStore);
    assert.ok(result.cpp.includes(`return (*${material[1]});`));
    assert.ok(
        result.cpp.indexOf(creation[0]) < result.cpp.indexOf(cacheStore[0]),
    );
    assert.ok(
        result.cpp.indexOf(cacheStore[0]) <
            result.cpp.indexOf(`return (*${material[1]});`),
    );
});

test("materializes a tuple bound through an unknown parameter for Array.every", () => {
    const result = compileSource(`
        function finiteVector(value: unknown): boolean {
            return Array.isArray(value) &&
                value.every((entry) =>
                    typeof entry === "number" && Number.isFinite(entry));
        }
        const dynamic = Math.random();
        finiteVector([dynamic, 2, 3]);
    `);

    // A fresh array is the document's own: its elements stored once.
    assert.match(
        result.cpp,
        /JsonValue::from_array\(bbl::js::JsonValue::Array\{bbl::js::json_value\(v_dynamic\), /,
    );
    assert.doesNotMatch(result.cpp, /from_tuple_view/);
    assert.match(result.cpp, /bool \w*_every_result_\d+ = true;/);
});

test("expands a static tuple spread at a Color3 sink", () => {
    const result = compileSource(`
        import {
            createEngine,
            createStandardMaterial,
        } from "@babylonjs/lite";
        const COLOR: readonly [number, number, number] = [0.35, 0.6, 1];
        await createEngine({});
        const material = createStandardMaterial();
        material.emissiveColor = [...COLOR] as [number, number, number];
    `);

    assert.match(
        result.cpp,
        /Color3\{static_cast<float>\([^[]+\[0\]\), static_cast<float>\([^[]+\[1\]\), static_cast<float>\([^[]+\[2\]\)\}/,
    );
});

test("refreshes array-backed material fields when the UBO is marked dirty", () => {
    const result = compileSource(`
        import {
            createEngine,
            createStandardMaterial,
            markMaterialUboDirty,
        } from "@babylonjs/lite";

        await createEngine({});
        class SelectionMaterial {
            private readonly color: [number, number, number] = [0.4, 0.75, 1];
            private readonly material = createStandardMaterial();

            constructor() {
                this.material.emissiveColor = this.color;
            }

            setColor(color: readonly [number, number, number]): void {
                this.color[0] = color[0];
                this.color[1] = color[1];
                this.color[2] = color[2];
                markMaterialUboDirty(this.material);
            }
        }

        const selection = new SelectionMaterial();
        selection.setColor([1, 0.35, 0.3]);
    `);

    assert.equal(
        result.cpp.match(/\.emissive_factor = bbl::Color3\{/g)?.length,
        2,
    );
    assert.match(
        result.cpp,
        /\.emissive_factor = bbl::Color3\{[^;]+\};\s*bbl::mark_material_ubo_dirty/,
    );
});

test("compiles generated mesh data and the file-texture contract", () => {
    const result = compileSource(
        readFileSync(resolve("examples/regression-runtime-sweep.ts"), "utf8"),
        { ...labDeployment, fileName: "examples/regression-runtime-sweep.ts" },
    );

    assert.ok(result.manifest.features.includes("mesh:from-data"));
    assert.ok(result.manifest.features.includes("mesh:thin-instances"));
    assert.ok(result.manifest.features.includes("mesh:thin-instances-dynamic"));
    assert.ok(result.manifest.features.includes("scene:remove"));
    const mesh =
        /bbl::create_retained_mesh_from_data\([^,\n]+, "lattice_a", (\w+), (\w+), (\w+), (\w+)\.to_optional\(\), std::nullopt, std::nullopt, std::nullopt\)/.exec(
            result.cpp,
        );
    assert.ok(mesh);
    for (const [index, field] of ["positions", "normals", "indices"].entries())
        assert.match(
            result.cpp,
            new RegExp(
                `auto ${mesh[index + 1]} = bbl::js::snapshot_value\\(\\w*cube\\.${field}\\);`,
            ),
        );
    assert.match(
        result.cpp,
        new RegExp(
            `auto ${mesh[4]} = bbl::js::Nullable<bbl::js::F32Array>\\{\\w*cube\\.uvs\\};`,
        ),
    );
    // The pool is adopted by name; the capacity expression itself is not
    // part of the contract.
    assert.match(
        result.cpp,
        /std::variant<bbl::js::F32Array, bbl::js::F64Array> (\w+) = std::variant<bbl::js::F32Array, bbl::js::F64Array>\{std::in_place_index<0>, \w*bufferA\};\s*bbl::set_thin_instances\([^,\n]+, \w*latticeA, \1, /,
    );
    // A file texture materializes as a compile-time asset and loads through
    // the pinned sampler contract (nearest, unmipped, sRGB base color),
    // attaching after the material exists.
    assert.match(
        result.cpp,
        /bbl::load_file_texture\(v_engine, bbl::asset_path\("[0-9a-f]+-ebf71b300f43563f\.png"\), bbl::TextureSamplerState\{bbl::TextureFilter::nearest, bbl::TextureFilter::nearest, bbl::TextureMipmapMode::nearest, bbl::TextureAddressMode::repeat, bbl::TextureAddressMode::repeat, 1\.0f, 0\.0f\}, false, true, false\)/,
    );
    assert.match(
        result.cpp,
        /bbl::set_pbr_texture\(v_engine, v_bblite_material_\d+, bbl::MaterialTextureSlot::base_color, v_decalTexture\);/,
    );
    assert.ok(
        result.manifest.assets.some((asset) =>
            asset.output.endsWith("ebf71b300f43563f.png"),
        ),
    );
    assert.doesNotMatch(
        result.cpp,
        /(?:Engine|Surface)Context\d*Data/,
        "type probes must not leak unused context declarations",
    );
});

test("carries file-texture address modes into the sampler", () => {
    const result = compileSource(
        `
        import { createEngine, loadTexture2D } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            await loadTexture2D(
                engine,
                "/textures/nme/ebf71b300f43563f.png",
                {
                    addressModeU: "clamp-to-edge",
                    addressModeV: "mirror-repeat",
                },
            );
        }
    `,
        labDeployment,
    );

    assert.match(
        result.cpp,
        /TextureAddressMode::clamp, bbl::TextureAddressMode::mirror/,
    );
});

test("file-texture options spread from a constant read the constant's own fields", () => {
    const result = compileSource(
        `
        import { createEngine, loadTexture2D, type EngineContext, type Texture2D } from "@babylonjs/lite";

        const REPEAT = { addressModeU: "mirror-repeat" as const, addressModeV: "clamp-to-edge" as const, invertY: false, mipMaps: false };
        function load(engine: EngineContext, srgb: boolean): Promise<Texture2D> {
            return loadTexture2D(engine, "/textures/nme/ebf71b300f43563f.png", { srgb, ...REPEAT });
        }
        async function main() {
            const engine = await createEngine({});
            await Promise.all([load(engine, true), load(engine, false)]);
        }
    `,
        labDeployment,
    );

    // Each call keeps the spread's sampler and upload flags beside its own.
    const loads = [
        ...result.cpp.matchAll(
            /bbl::TextureMipmapMode::nearest, bbl::TextureAddressMode::mirror, bbl::TextureAddressMode::clamp, [^}]*\}, false, (true|false), false\)/g,
        ),
    ].map((match) => match[1]);
    assert.deepEqual(loads, ["true", "false"]);
});

test("a profile a constant table gives by a known key composes each key's shader", () => {
    // A profile helper reads a constant table by a string-union key, with a
    // fallback, and an options builder derives flags from the profile: each
    // key's arm composes its own program. The table's entry is a literal,
    // one a helper builds from known scalars, or one a conditional spread
    // adds where a known flag allows it.
    const programs = (source: string): readonly string[] =>
        compileSource(source).manifest.customShaderPrograms.map(
            (program) =>
                /position \* ([0-9.]+)/.exec(program.vertexSource)?.[1] ?? "",
        );
    for (const source of [
        `import { createEngine, createSceneContext, createShaderMaterial, wgsl, type EngineContext, type ShaderMaterial } from "@babylonjs/lite";
type Kind = "a" | "b";
interface Profile { file: string; height: number; shared?: boolean; tint: "body" | false }
const BASE: Profile = { file: "base.glb", height: 4.4, tint: "body" };
const DEMO = typeof location === "undefined" ? false : location.search.includes("demo");
function allows(kind: Kind): boolean { return kind !== "b"; }
function matched(file: string, height: number): Profile {
    return { ...BASE, file, height, shared: true };
}
const MODELS: Readonly<{ a: Profile } & Partial<Record<Kind, Profile>>> = {
    a: BASE,
    b: { file: "b.glb", height: 3, shared: true, tint: "body" },
};
function profile(kind: Kind): Profile {
    const p = MODELS[kind] ?? BASE;
    if (!p) throw new Error(\`no \${kind}\`);
    return p;
}
function options(kind: Kind) {
    const p = profile(kind);
    return { file: p.file, shared: p.shared === true, tinted: p.tint !== false } as const;
}
const VERTEX = \`struct VertexOutput { @builtin(position) position: vec4<f32>, };
@vertex fn mainVertex(input: VertexInput) -> VertexOutput { var out: VertexOutput; out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position * /*S*/, 1.0); return out; }\`;
const FRAGMENT = wgsl\`@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\`;
function surface(engine: EngineContext, o: { file: string; shared: boolean; tinted: boolean }): ShaderMaterial {
    const vertex = VERTEX.replace("/*S*/", o.shared ? (o.tinted ? "0.5" : "0.6") : "1.0");
    return createShaderMaterial({ name: o.file, vertexSource: wgsl\`\${vertex}\`, fragmentSource: FRAGMENT, attributes: ["position"], uniforms: ["worldViewProjection"] });
}
async function main(): Promise<void> {
    const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
    createSceneContext(engine);
    const kinds = (["a", "b"] as const).filter(() => Math.random() < 2);
    const build = (kind: Kind): ShaderMaterial => surface(engine, options(kind));
    kinds.map(build);
}
void main();
`,
        `import { createEngine, createSceneContext, createShaderMaterial, wgsl, type EngineContext, type ShaderMaterial } from "@babylonjs/lite";
type Kind = "a" | "b";
interface Profile { file: string; height: number; shared?: boolean; tint: "body" | false }
const BASE: Profile = { file: "base.glb", height: 4.4, tint: "body" };
const DEMO = typeof location === "undefined" ? false : location.search.includes("demo");
function allows(kind: Kind): boolean { return kind !== "b"; }
function matched(file: string, height: number): Profile {
    return { ...BASE, file, height, shared: true };
}
const MODELS: Readonly<{ a: Profile } & Partial<Record<Kind, Profile>>> = {
    a: BASE,
    b: matched("b.glb", 3),
};
function profile(kind: Kind): Profile {
    const p = MODELS[kind] ?? BASE;
    if (!p) throw new Error(\`no \${kind}\`);
    return p;
}
function options(kind: Kind) {
    const p = profile(kind);
    return { file: p.file, shared: p.shared === true, tinted: p.tint !== false } as const;
}
const VERTEX = \`struct VertexOutput { @builtin(position) position: vec4<f32>, };
@vertex fn mainVertex(input: VertexInput) -> VertexOutput { var out: VertexOutput; out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position * /*S*/, 1.0); return out; }\`;
const FRAGMENT = wgsl\`@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\`;
function surface(engine: EngineContext, o: { file: string; shared: boolean; tinted: boolean }): ShaderMaterial {
    const vertex = VERTEX.replace("/*S*/", o.shared ? (o.tinted ? "0.5" : "0.6") : "1.0");
    return createShaderMaterial({ name: o.file, vertexSource: wgsl\`\${vertex}\`, fragmentSource: FRAGMENT, attributes: ["position"], uniforms: ["worldViewProjection"] });
}
async function main(): Promise<void> {
    const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
    createSceneContext(engine);
    const kinds = (["a", "b"] as const).filter(() => Math.random() < 2);
    const build = (kind: Kind): ShaderMaterial => surface(engine, options(kind));
    kinds.map(build);
}
void main();
`,
        `import { createEngine, createSceneContext, createShaderMaterial, wgsl, type EngineContext, type ShaderMaterial } from "@babylonjs/lite";
type Kind = "a" | "b";
interface Profile { file: string; height: number; shared?: boolean; tint: "body" | false }
const BASE: Profile = { file: "base.glb", height: 4.4, tint: "body" };
const DEMO = typeof location === "undefined" ? false : location.search.includes("demo");
function allows(kind: Kind): boolean { return kind !== "b"; }
function matched(file: string, height: number): Profile {
    return { ...BASE, file, height, shared: true };
}
const MODELS: Readonly<{ a: Profile } & Partial<Record<Kind, Profile>>> = {
    a: BASE,
    ...(!DEMO || allows("b") ? { b: { ...BASE, file: "b.glb", height: 3, shared: true } } : {}),
};
function profile(kind: Kind): Profile {
    const p = MODELS[kind] ?? BASE;
    if (!p) throw new Error(\`no \${kind}\`);
    return p;
}
function options(kind: Kind) {
    const p = profile(kind);
    return { file: p.file, shared: p.shared === true, tinted: p.tint !== false } as const;
}
const VERTEX = \`struct VertexOutput { @builtin(position) position: vec4<f32>, };
@vertex fn mainVertex(input: VertexInput) -> VertexOutput { var out: VertexOutput; out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position * /*S*/, 1.0); return out; }\`;
const FRAGMENT = wgsl\`@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\`;
function surface(engine: EngineContext, o: { file: string; shared: boolean; tinted: boolean }): ShaderMaterial {
    const vertex = VERTEX.replace("/*S*/", o.shared ? (o.tinted ? "0.5" : "0.6") : "1.0");
    return createShaderMaterial({ name: o.file, vertexSource: wgsl\`\${vertex}\`, fragmentSource: FRAGMENT, attributes: ["position"], uniforms: ["worldViewProjection"] });
}
async function main(): Promise<void> {
    const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
    createSceneContext(engine);
    const kinds = (["a", "b"] as const).filter(() => Math.random() < 2);
    const build = (kind: Kind): ShaderMaterial => surface(engine, options(kind));
    kinds.map(build);
}
void main();
`,
    ])
        assert.deepEqual(programs(source), ["1.0", "0.5"]);
});

test("a shader text appended under a known condition composes its program, and a known string compared with a boolean folds", () => {
    // `scale += ...` under a condition generation knows keeps the text,
    // as `scale = scale + ...` does; a herd builder awaits a cache, then
    // composes each part from options a key's helper built.
    const scales = (source: string): readonly (string | undefined)[] =>
        compileSource(source).manifest.customShaderPrograms.map(
            (program) =>
                /position \* ([^,]+), 1\.0/.exec(program.vertexSource)?.[1],
        );
    assert.deepEqual(
        scales(`import { createEngine, createSceneContext, createShaderMaterial, wgsl, type EngineContext, type ShaderMaterial } from "@babylonjs/lite";
type Kind = "a" | "b";
interface Coat { tint: number }
interface Opts { file: string; fade?: boolean; coat?: Coat; albedo?: number; highlight?: { strength: number }; clips: readonly string[] }
const COAT: Coat = { tint: 0.5 };
const VERTEX = \`struct VertexOutput { @builtin(position) position: vec4<f32>, };
@vertex fn mainVertex(input: VertexInput) -> VertexOutput { var out: VertexOutput; out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position * /*S*/, 1.0); return out; }\`;
const FRAGMENT = wgsl\`@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\`;
const cache = new Map<string, Promise<number[]>>();
async function prepare(o: Opts): Promise<number[]> {
    await Promise.resolve();
    return o.clips.map((clip) => clip.length);
}
function prepared(o: Opts): Promise<number[]> {
    let p = cache.get(o.file);
    if (!p) { p = prepare(o); cache.set(o.file, p); }
    return p;
}
function surface(engine: EngineContext, name: string, fade: boolean, coat: Coat | undefined, albedo: number | undefined): ShaderMaterial {
    const s = { fade, coat, albedo };
    let scale = s.fade ? "0.5" : "1.0";
    if (s.fade) scale += " * 0.9";
    const vertex = VERTEX.replace("/*S*/", scale);
    return createShaderMaterial({ name, vertexSource: wgsl\`\${vertex}\`, fragmentSource: FRAGMENT, attributes: ["position"], uniforms: ["worldViewProjection"] });
}
function instance(engine: EngineContext, o: Opts, parts: number[]): ShaderMaterial[] {
    const out: ShaderMaterial[] = [];
    const part = parts.length; out.push(surface(engine, \`\${o.file}-\${part}\`, o.fade === true, o.coat, o.albedo));
    return out;
}
function create(engine: EngineContext, o: Opts): Promise<ShaderMaterial[]> {
    void prepared;
    return Promise.resolve(instance(engine, o, [1]));
}
function options(kind: Kind) {
    return { file: \`\${kind}.glb\`, clips: ["idle", "walk"], fade: true, coat: { tint: 0.5 } } as const;
}
async function main(): Promise<void> {
    const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
    createSceneContext(engine);
    const lit = Math.random() < 2 ? { highlight: { strength: 2 } } : undefined;
    const kinds = (["a", "b"] as const).filter(() => Math.random() < 2);
    const build = (kind: Kind): Promise<ShaderMaterial[]> => create(engine, { ...options(kind)});
    await Promise.all(kinds.map(build));
}
void main();
`),
        // `options` always sets `fade`: the unfaded program is unreachable.
        ["0.5 * 0.9"],
    );
    // The record a spread copies keeps the coat its helper always sets.
    assert.deepEqual(
        scales(`import { createEngine, createSceneContext, createShaderMaterial, wgsl, type EngineContext, type ShaderMaterial } from "@babylonjs/lite";
type Kind = "a" | "b";
interface Coat { tint: number }
interface Opts { file: string; fade?: boolean; coat?: Coat; albedo?: number; highlight?: { strength: number }; clips: readonly string[] }
const COAT: Coat = { tint: 0.5 };
const VERTEX = \`struct VertexOutput { @builtin(position) position: vec4<f32>, };
@vertex fn mainVertex(input: VertexInput) -> VertexOutput { var out: VertexOutput; out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position * /*S*/, 1.0); return out; }\`;
const FRAGMENT = wgsl\`@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\`;
const cache = new Map<string, Promise<number[]>>();
async function prepare(o: Opts): Promise<number[]> {
    await Promise.resolve();
    return o.clips.map((clip) => clip.length);
}
function prepared(o: Opts): Promise<number[]> {
    let p = cache.get(o.file);
    if (!p) { p = prepare(o); cache.set(o.file, p); }
    return p;
}
function surface(engine: EngineContext, name: string, s: { fade: boolean; coat?: Coat; albedo?: number; highlight?: { strength: number } }): ShaderMaterial {
    let scale = s.fade ? "0.5" : "1.0";
    if (s.coat) scale += " * 0.9";
    if (s.albedo !== undefined) scale += " * 0.8";
    if (s.highlight) scale += " * 1.1";
    const vertex = VERTEX.replace("/*S*/", scale);
    return createShaderMaterial({ name, vertexSource: wgsl\`\${vertex}\`, fragmentSource: FRAGMENT, attributes: ["position"], uniforms: ["worldViewProjection"] });
}
function instance(engine: EngineContext, o: Opts, parts: number[]): ShaderMaterial[] {
    const out: ShaderMaterial[] = [];
    for (const part of parts) out.push(surface(engine, \`\${o.file}-\${part}\`, { fade: o.fade === true, coat: o.coat, albedo: o.albedo, highlight: o.highlight }));
    return out;
}
async function create(engine: EngineContext, o: Opts): Promise<ShaderMaterial[]> {
    const parts = await prepared(o);
    return instance(engine, o, parts);
}
function options(kind: Kind) {
    return { file: \`\${kind}.glb\`, clips: ["idle", "walk"], fade: true, coat: COAT } as const;
}
async function main(): Promise<void> {
    const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
    createSceneContext(engine);
    const lit = Math.random() < 2 ? { highlight: { strength: 2 } } : undefined;
    const kinds = (["a", "b"] as const).filter(() => Math.random() < 2);
    const build = (kind: Kind): Promise<ShaderMaterial[]> => create(engine, { ...options(kind), highlight: lit?.highlight });
    await Promise.all(kinds.map(build));
}
void main();
`),
        ["0.5 * 0.9 * 1.1", "0.5 * 0.9"],
    );
    // A known string is no boolean: comparing one with `false` folds.
    assert.deepEqual(
        scales(`import { createEngine, createSceneContext, createShaderMaterial, wgsl, type EngineContext } from "@babylonjs/lite";
interface Profile { file: string; shared?: boolean; tint: "body" | false }
const B: Profile = { file: "b.glb", shared: true, tint: "body" };
const VERTEX = \`struct VertexOutput { @builtin(position) position: vec4<f32>, };
@vertex fn mainVertex(input: VertexInput) -> VertexOutput { var out: VertexOutput; out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position * /*S*/, 1.0); return out; }\`;
const FRAGMENT = wgsl\`@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\`;
function surface(engine: EngineContext, p: Profile): void {
    const a = MODE === 1 ? p.shared === true : MODE === 2 ? p.tint !== false : p.file === "b.glb";
    const vertex = VERTEX.replace("/*S*/", a ? "0.5" : "1.0");
    createShaderMaterial({ name: "m", vertexSource: wgsl\`\${vertex}\`, fragmentSource: FRAGMENT, attributes: ["position"], uniforms: ["worldViewProjection"] });
}
const MODE: number = 2;
async function main(): Promise<void> {
    const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
    createSceneContext(engine);
    const p = B;
    surface(engine, p);
}
void main();
`),
        ["0.5"],
    );
});

test("a material builder iterated over a constant table's keys composes one program per key", () => {
    const source = (iteration: string): string =>
        `import { addToScene, createArcRotateCamera, createEngine, createPlane, createSceneContext, createShaderMaterial, registerScene, startEngine, wgsl, type EngineContext, type ShaderMaterial } from "@babylonjs/lite";
const VERTEX = \`struct VertexOutput { @builtin(position) position: vec4<f32>, };
@vertex fn mainVertex(input: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position * /*SCALE*/, 1.0);
  return out;
}\`;
const FRAGMENT = wgsl\`@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0, 0.5, 0.2, 1.0); }\`;
const KINDS = { small: { scale: "0.5", wide: false }, large: { scale: "2.0", wide: true } } as const;
type Kind = keyof typeof KINDS;
function material(engine: EngineContext, kind: Kind): ShaderMaterial {
    const def = KINDS[kind];
    let vertex = VERTEX.replace("/*SCALE*/", def.scale);
    if (def.wide) vertex = vertex.replace("input.position *", "vec3<f32>(2.0, 1.0, 1.0) * input.position *");
    return createShaderMaterial({ name: kind, vertexSource: wgsl\`\${vertex}\`, fragmentSource: FRAGMENT, attributes: ["position"], uniforms: ["worldViewProjection"] });
}
async function main(): Promise<void> {
    const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
    const scene = createSceneContext(engine);
    scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 8, { x: 0, y: 0, z: 0 });
    const kinds = Object.keys(KINDS) as Kind[];
    ${iteration}
    const byKind = new Map(kinds.map((kind, i) => [kind, materials[i]!]));
    const plane = createPlane(engine, { width: 2, height: 2 });
    plane.material = byKind.get("large")!;
    addToScene(scene, plane);
    await registerScene(scene);
    await startEngine(engine);
}
void main();
`;
    const programs = (iteration: string): readonly string[] =>
        compileSource(source(iteration)).manifest.customShaderPrograms.map(
            (program) =>
                program.name +
                (/input.position \* 0.5/.test(program.vertexSource)
                    ? ":small"
                    : "") +
                (/vec3<f32>\(2.0, 1.0, 1.0\) \* input.position \* 2.0/.test(
                    program.vertexSource,
                )
                    ? ":wide"
                    : ""),
        );
    for (const iteration of [
        "const materials = kinds.map((kind) => material(engine, kind));",
        "const materials: ShaderMaterial[] = []; for (const kind of kinds) materials.push(material(engine, kind));",
    ])
        assert.deepEqual(programs(iteration), ["small:small", "large:wide"]);
    // An asynchronous builder in a realm, awaited together.
    const directory = resolve("artifacts/compiler-keyed-async-builder");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "noop-worker.ts"), "self.close();\n");
    const realm = source(
        "const materials = await Promise.all(kinds.map((kind) => built(engine, kind)));",
    )
        .replace(
            "async function main(): Promise<void> {",
            "async function built(engine: EngineContext, kind: Kind): Promise<ShaderMaterial> { await Promise.resolve(); return material(engine, kind); }\nasync function main(): Promise<void> {",
        )
        .replace(
            "void main();",
            'const worker = new Worker(new URL("./noop-worker.ts", import.meta.url), { type: "module" });\nworker.terminate();\nvoid main();',
        );
    assert.deepEqual(
        compileSource(realm, {
            fileName: join(directory, "entry.ts"),
        }).manifest.customShaderPrograms.map((program) => program.name),
        ["small", "large"],
    );
});

test("a shader material's attribute list a function pushes onto is the list it holds", () => {
    const program = (pushes: string): string => `
        import { addToScene, createArcRotateCamera, createEngine, createPlane, createSceneContext, createShaderMaterial, registerScene, startEngine, wgsl } from "@babylonjs/lite";
        const VERTEX = wgsl\`struct VertexOutput { @builtin(position) position: vec4<f32>, };
        @vertex fn mainVertex(input: VertexInput) -> VertexOutput {
          var out: VertexOutput;
          out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position + input.normal * 0.0, 1.0);
          return out;
        }\`;
        const FRAGMENT = wgsl\`@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0, 0.5, 0.2, 1.0); }\`;
        function material(normals: boolean, uvs: boolean) {
            const attributes = normals ? ["position", "normal"] : ["position"];
            ${pushes}
            return createShaderMaterial({ name: "m", vertexSource: VERTEX, fragmentSource: FRAGMENT, attributes: attributes as ("position" | "normal" | "uv")[], uniforms: ["worldViewProjection"] });
        }
        async function main(): Promise<void> {
            const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
            const scene = createSceneContext(engine);
            scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 8, { x: 0, y: 0, z: 0 });
            const plane = createPlane(engine, { width: 2, height: 2 });
            plane.material = material(true, true);
            addToScene(scene, plane);
            await registerScene(scene);
            await startEngine(engine);
        }
        void main();
    `;
    const [shader] = compileSource(program(`if (uvs) attributes.push("uv");`))
        .manifest.customShaderPrograms;
    assert.deepEqual(shader?.attributes, ["position", "normal", "uv"]);
    // A push a run-time test guards, or an element write, leaves no list
    // generation knows.
    for (const pushes of [
        `if (Math.random() > 2) attributes.push("uv");`,
        `if (uvs) attributes.push("uv"); attributes[0] = Math.random() > 2 ? "uv" : "position";`,
    ])
        assert.throws(
            () => compileSource(program(pushes)),
            /Expected a static array literal/,
        );
});

test("carries a base-color image's own encoding, either way", () => {
    // Upstream keeps the format on the `Texture2D` `loadTexture2D` built
    // (`opts.srgb ?? false` picks `rgba8unorm-srgb` or `rgba8unorm`), so the
    // slot samples what the scene asked for. A material that decodes its own
    // albedo — `setPbrGammaAlbedo` — loads the linear one.
    const load = (options: string) =>
        compileSource(
            `
            import {
                createEngine,
                createPbrMaterial,
                createSolidTexture2D,
                loadTexture2D,
            } from "@babylonjs/lite";

            async function main() {
                const engine = await createEngine({});
                const texture = await loadTexture2D(engine, "/textures/nme/ebf71b300f43563f.png"${options});
                const material = createPbrMaterial({
                    baseColorTexture: texture,
                    ormTexture: createSolidTexture2D(engine, 1, 0.5, 0),
                });
            }
        `,
            labDeployment,
        ).cpp;
    // The penultimate `load_file_texture` argument is the requested encoding;
    // premultiplication follows it. The attach carries the encoding onto the
    // record's own base-colour lane.
    assert.match(
        load(", { srgb: true }"),
        /bbl::load_file_texture\([^\n]+, true, false\)/,
    );
    assert.match(load(""), /bbl::load_file_texture\([^\n]+, false, false\)/);
    for (const options of [", { srgb: true }", ""]) {
        assert.match(
            load(options),
            /bbl::set_pbr_texture\([^;]*MaterialTextureSlot::base_color/,
        );
    }
});

test("compiles scene17's file ORM and matrix-constructor chain", () => {
    const sourcePath = "corpus/babylon-lite/lab/lite/src/lite/scene17.ts";
    const result = compileSource(readFileSync(resolve(sourcePath), "utf8"), {
        fileName: sourcePath,
    });

    assert.ok(result.manifest.features.includes("texture:file"));
    assert.ok(result.manifest.features.includes("material:pbr"));
    assert.ok(result.manifest.features.includes("mesh:thin-instances"));
    assert.ok(result.manifest.features.includes("mesh:thin-instance-colors"));
    assert.deepEqual(
        result.manifest.sceneMeshes.map((mesh) => [
            mesh.thinInstances,
            mesh.thinInstanceColors,
        ]),
        [
            ["always", true],
            ["always", true],
            [undefined, undefined],
        ],
    );
    assert.match(
        result.cpp,
        /\.orm = bbl::SolidTexture\{bbl::Color4\{1\.0f, 1\.0f, 1\.0f, 1\.0f\}\}/,
    );
    assert.match(
        result.cpp,
        /bbl::set_pbr_texture\(v_engine, v_bblite_material_\d+, bbl::MaterialTextureSlot::orm, v_ormTex\);/,
    );
    assert.match(
        result.cpp,
        /bbl::upstream::create_translation_mat4\(\(-2\.0\), 2\.0, 0\.0\)/,
    );
    assert.match(result.cpp, /bbl::upstream::create_identity_mat4\(\)/);
    assert.match(result.cpp, /bbl::set_thin_instance_colors\(/);
});

test("binds an sRGB file texture in PBR's ORM slot through its own encoding", () => {
    // The pin keeps the format on the Texture2D, so an ORM map loaded sRGB
    // is sampled through the sRGB view; the slot takes the texture's own
    // encoding (TextureData::srgb) rather than a per-slot rule.
    const result = compileSource(
        `
            import {
                createEngine,
                createPbrMaterial,
                createSolidTexture2D,
                loadTexture2D,
            } from "@babylonjs/lite";

            async function main() {
                const engine = await createEngine({});
                const orm = await loadTexture2D(
                    engine,
                    "/textures/nme/ebf71b300f43563f.png",
                    { srgb: true },
                );
                createPbrMaterial({
                    baseColorTexture: createSolidTexture2D(engine, 1, 1, 1),
                    ormTexture: orm,
                });
            }
        `,
        labDeployment,
    );
    assert.match(result.cpp, /bbl::load_file_texture\([^;]*, true, false\)/);
    assert.match(
        result.cpp,
        /bbl::set_pbr_texture\([^;]*MaterialTextureSlot::orm/,
    );
});

test("reaches scene transmission only from the pin's transmission calls", () => {
    const compile = (activation: string) =>
        compileSource(`
            import {
                createEngine,
                createPbrMaterial,
                createSceneContext,
                createSolidTexture2D,
                enableSceneTransmission,
                setPbrSkybox,
            } from "@babylonjs/lite";

            async function main() {
                const engine = await createEngine({});
                const scene = createSceneContext(engine);
                const material = createPbrMaterial({
                    baseColorTexture: createSolidTexture2D(engine, 1, 1, 1),
                    ormTexture: createSolidTexture2D(engine, 1, 0.5, 0),
                });
                ${activation}
            }
        `).manifest.features;

    // The pin's setPbrSkybox registers the skybox extension alone.
    const skybox = compile("setPbrSkybox(material);");
    assert.ok(!skybox.includes("renderer:transmission"));
    assert.ok(!skybox.includes("material:pbr-linear-image-processing"));

    const retargeted = compile("enableSceneTransmission(scene, engine);");
    assert.ok(retargeted.includes("renderer:transmission"));
    assert.ok(retargeted.includes("material:pbr-linear-image-processing"));

    // PbrMaterialProps has no transmissive or subsurface field: the pin's
    // createPbrMaterial would carry either inertly, so neither may reach
    // the transmission renderer here.
    for (const option of [
        "transmissive: true",
        "subsurface: { refraction: { intensity: 1 } }",
    ]) {
        assert.throws(
            () =>
                compileSource(`
                    import { createEngine, createPbrMaterial } from "@babylonjs/lite";
                    async function main() {
                        await createEngine({});
                        createPbrMaterial({ ${option} });
                    }
                `),
            (error: unknown) =>
                error instanceof CompileError &&
                /createPbrMaterial takes no/.test(error.message),
        );
    }
});

test("carries scene-code PBR occlusion strength into composition and runtime", () => {
    const result = compileSource(`
        import {
            createEngine,
            createPbrMaterial,
            createSolidTexture2D,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            createPbrMaterial({
                baseColorTexture: createSolidTexture2D(engine, 1, 1, 1),
                ormTexture: createSolidTexture2D(engine, 1, 0.5, 0),
                occlusionStrength: 0,
            });
        }
    `);

    assert.equal(result.manifest.scenePbrMaterials[0]?.occlusionStrength, 0);
    assert.match(
        result.cpp,
        /\.occlusion_strength = 0\.0f, \.metallic_f0_factor = 1\.0f/,
    );
    assert.doesNotMatch(
        result.cpp,
        /\.materials, [^\]]+\)\.occlusion_strength =/,
    );

    const defaultResult = compileSource(`
        import {
            createEngine,
            createPbrMaterial,
            createSolidTexture2D,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            createPbrMaterial({
                baseColorTexture: createSolidTexture2D(engine, 1, 1, 1),
                ormTexture: createSolidTexture2D(engine, 1, 0.5, 0),
            });
        }
    `);
    assert.equal(
        defaultResult.manifest.scenePbrMaterials[0]?.occlusionStrength,
        undefined,
    );
    assert.match(
        defaultResult.cpp,
        /\.occlusion_strength = 1\.0f, \.metallic_f0_factor = 1\.0f/,
    );

    assert.throws(
        () =>
            compileSource(`
                import {
                    createArcRotateCamera,
                    createEngine,
                    createPbrMaterial,
                    createSolidTexture2D,
                } from "@babylonjs/lite";

                async function main() {
                    const engine = await createEngine({});
                    const camera = createArcRotateCamera(0, 1, 10, { x: 0, y: 0, z: 0 });
                    createPbrMaterial({
                        baseColorTexture: createSolidTexture2D(engine, 1, 1, 1),
                        ormTexture: createSolidTexture2D(engine, 1, 0.5, 0),
                        occlusionStrength: camera.alpha,
                    });
                }
            `),
        /occlusionStrength must be a finite static number/,
    );

    for (const nonfinite of ["1 / 0", "0 / 0"]) {
        assert.throws(
            () =>
                compileSource(`
                    import {
                        createEngine,
                        createPbrMaterial,
                        createSolidTexture2D,
                    } from "@babylonjs/lite";

                    async function main() {
                        const engine = await createEngine({});
                        createPbrMaterial({
                            baseColorTexture: createSolidTexture2D(engine, 1, 1, 1),
                            ormTexture: createSolidTexture2D(engine, 1, 0.5, 0),
                            occlusionStrength: ${nonfinite},
                        });
                    }
                `),
            /occlusionStrength must be a finite static number/,
        );
    }
});

test("carries scene-code PBR specular AA into composition and runtime", () => {
    const result = compileSource(`
        import {
            createEngine,
            createPbrMaterial,
            createSolidTexture2D,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            createPbrMaterial({
                baseColorTexture: createSolidTexture2D(engine, 1, 1, 1),
                ormTexture: createSolidTexture2D(engine, 1, 0.5, 0),
                enableSpecularAA: true,
            });
        }
    `);

    assert.equal(result.manifest.scenePbrMaterials[0]?.enableSpecularAA, true);
    assert.match(
        result.cpp,
        /\.double_sided = false, \.specular_aa = true, \.skybox_mode = false/,
    );

    assert.throws(
        () =>
            compileSource(`
                import {
                    createArcRotateCamera,
                    createEngine,
                    createPbrMaterial,
                    createSolidTexture2D,
                } from "@babylonjs/lite";

                async function main() {
                    const engine = await createEngine({});
                    const camera = createArcRotateCamera(0, 1, 10, { x: 0, y: 0, z: 0 });
                    createPbrMaterial({
                        baseColorTexture: createSolidTexture2D(engine, 1, 1, 1),
                        ormTexture: createSolidTexture2D(engine, 1, 0.5, 0),
                        enableSpecularAA: camera.alpha > 0,
                    });
                }
            `),
        /Expected a boolean literal/,
    );
});

test("derives mapped PBR emissive colours from static source expressions", () => {
    const result = compileSource(`
        import {
            createEngine,
            createPbrMaterial,
            createSolidTexture2D,
            setPbrEmissive,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const base = createSolidTexture2D(engine, 1, 1, 1);
            const orm = createSolidTexture2D(engine, 1, 0.5, 0);
            const colors: readonly [number, number, number][] = [
                [0.95, 0.24, 0.52],
                [0.22, 0.34, 0.95],
            ];
            colors.map((rgb) => {
                const material = createPbrMaterial({
                    baseColorTexture: base,
                    baseColorFactor: [rgb[0], rgb[1], rgb[2], 1],
                    ormTexture: orm,
                });
                setPbrEmissive(material, [
                    rgb[0] * 0.35,
                    rgb[1] * 0.35,
                    rgb[2] * 0.35,
                ]);
                return material;
            });
        }
    `);

    assert.deepEqual(
        result.manifest.scenePbrMaterials.map(
            ({ emissiveColor }) => emissiveColor,
        ),
        [
            [0.95 * 0.35, 0.24 * 0.35, 0.52 * 0.35],
            [0.22 * 0.35, 0.34 * 0.35, 0.95 * 0.35],
        ],
    );
    assert.equal(result.cpp.match(/bbl::set_pbr_emissive\(/g)?.length, 2);
    assert.match(result.cpp, /static_cast<float>\(\(0\.95 \* 0\.35\)\)/);
});

test("keeps runtime PBR emissive colours on compile-time material lists", () => {
    const result = compileSource(`
        import {
            createEngine,
            createPbrMaterial,
            createSolidTexture2D,
            setPbrEmissive,
        } from "@babylonjs/lite";

        function seededRandom(seed: number): () => number {
            let state = seed;
            return () => {
                state = (state * 1664525 + 1013904223) & 0xffffffff;
                return (state >>> 0) / 0x100000000;
            };
        }

        async function main() {
            const engine = await createEngine({});
            const base = createSolidTexture2D(engine, 1, 1, 1);
            const orm = createSolidTexture2D(engine, 1, 0, 0);
            const random = seededRandom(42);
            const materials = [];
            for (let index = 0; index < 2; index++) {
                const red = random();
                const green = random();
                const blue = random();
                const material = createPbrMaterial({
                    baseColorTexture: base,
                    ormTexture: orm,
                });
                setPbrEmissive(material, [red, green, blue]);
                materials.push(material);
            }
        }
    `);

    assert.equal(result.manifest.scenePbrMaterials.length, 2);
    assert.deepEqual(
        result.manifest.scenePbrMaterials.map(
            ({ hasEmissiveColor, emissiveColor }) => ({
                hasEmissiveColor,
                emissiveColor,
            }),
        ),
        [
            { hasEmissiveColor: true, emissiveColor: undefined },
            { hasEmissiveColor: true, emissiveColor: undefined },
        ],
    );
    assert.equal(result.cpp.match(/bbl::set_pbr_emissive\(/g)?.length, 2);
    assert.match(
        result.cpp,
        /bbl::Color3\{static_cast<float>\(v_\w*red\), static_cast<float>\(v_\w*green\), static_cast<float>\(v_\w*blue\)\}/,
    );
});

test("derives PBR layer manifests from source values, not emitted C++", () => {
    const result = compileSource(`
        import {
            createEngine,
            createPbrMaterial,
            createSolidTexture2D,
            setPbrClearCoat,
            setPbrIridescence,
            setPbrSheen,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const material = createPbrMaterial({
                baseColorTexture: createSolidTexture2D(engine, 1, 1, 1),
                ormTexture: createSolidTexture2D(engine, 1, 0.5, 0),
            });
            const computed = Math.sqrt(0.25);
            setPbrClearCoat(material, {
                isEnabled: true,
                intensity: computed,
                roughness: computed,
                indexOfRefraction: computed,
            });
            setPbrIridescence(material, {
                isEnabled: true,
                intensity: computed,
                indexOfRefraction: computed,
                minimumThickness: computed,
                maximumThickness: computed,
            });
            setPbrSheen(material, {
                isEnabled: true,
                color: [computed, computed, computed],
                roughness: computed,
                intensity: computed,
            });
        }
    `);

    const material = result.manifest.scenePbrMaterials[0];
    assert.deepEqual(material?.clearCoat, { isEnabled: true });
    assert.deepEqual(material?.iridescence, { isEnabled: true });
    assert.deepEqual(material?.sheen, {
        isEnabled: true,
        hasTexture: false,
        albedoScaling: false,
    });
    assert.match(result.cpp, /std::sqrt\(0\.25\)/);
    assert.doesNotMatch(JSON.stringify(result.manifest), /null/);
});

test("preserves scene-code internal metallic F0 creation state", () => {
    const compileMaterial = (extraOption: string, setup = "") =>
        compileSource(`
            import {
                createArcRotateCamera,
                createEngine,
                createPbrMaterial,
                createSolidTexture2D,
            } from "@babylonjs/lite";

            async function main() {
                const engine = await createEngine({});
                ${setup}
                createPbrMaterial({
                    baseColorTexture: createSolidTexture2D(engine, 1, 1, 1),
                    ormTexture: createSolidTexture2D(engine, 1, 0.5, 0),
                    ${extraOption}
                });
            }
        `);

    const result = compileMaterial("_metallicF0Factor: 0.95,");
    assert.equal(result.manifest.scenePbrMaterials[0]?.metallicF0Factor, 0.95);
    assert.match(
        result.cpp,
        /\.occlusion_strength = 1\.0f, \.metallic_f0_factor = 0\.95f/,
    );
    assert.doesNotMatch(
        result.cpp,
        /\.materials, [^\]]+\)\.(?:metallic_f0_factor|specular_weight) =/,
    );

    const defaultResult = compileMaterial("");
    assert.equal(
        defaultResult.manifest.scenePbrMaterials[0]?.metallicF0Factor,
        undefined,
    );
    assert.match(
        defaultResult.cpp,
        /\.occlusion_strength = 1\.0f, \.metallic_f0_factor = 1\.0f/,
    );

    assert.throws(
        () =>
            compileMaterial(
                "_metallicF0Factor: camera.alpha,",
                "const camera = createArcRotateCamera(0, 1, 10, { x: 0, y: 0, z: 0 });",
            ),
        /_metallicF0Factor must be a finite static number/,
    );
    assert.throws(
        () => compileMaterial("_metallicF0Factor: 1 / 0,"),
        /_metallicF0Factor must be a finite static number/,
    );
    assert.throws(
        () => compileMaterial("_specularWeight: 0.5,"),
        /Reached PBR lowering supports/,
    );
});

test("lowers Scene 12 metallic-reflectance setter shapes", () => {
    const result = compileSource(
        `
        import {
            createEngine,
            createPbrMaterial,
            createSolidTexture2D,
            loadTexture2D,
            setPbrMetallicReflectance,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const metallic = await loadTexture2D(
                engine,
                "/textures/nme/ebf71b300f43563f.png",
            );
            const reflectance = await loadTexture2D(
                engine,
                "/textures/nme/ebf71b300f43563f.png",
            );
            const base = createSolidTexture2D(engine, 1, 1, 1);
            const orm = createSolidTexture2D(engine, 1, 0.5, 0);
            const r = Math.pow(255 / 255, 2.2);
            const g = Math.pow(250 / 255, 2.2);

            function makeMaterial(options: {
                metallic?: typeof metallic;
                reflectance?: typeof reflectance;
                alphaOnly?: boolean;
            }) {
                const material = createPbrMaterial({
                    baseColorTexture: base,
                    ormTexture: orm,
                    _metallicF0Factor: 0.95,
                });
                setPbrMetallicReflectance(material, {
                    color: [r, g, g],
                    texture: options.metallic,
                    reflectanceTexture: options.reflectance,
                    useOnlyMetallicFromTexture: options.alphaOnly,
                });
                return material;
            }

            makeMaterial({ metallic });
            makeMaterial({ reflectance });
            makeMaterial({ metallic, reflectance, alphaOnly: true });
        }
    `,
        labDeployment,
    );

    assert.deepEqual(
        result.manifest.scenePbrMaterials.map(
            (material) => material.metallicReflectance,
        ),
        [
            {
                hasColor: true,
                hasMetallicTexture: true,
                hasReflectanceTexture: false,
            },
            {
                hasColor: true,
                hasMetallicTexture: false,
                hasReflectanceTexture: true,
            },
            {
                hasColor: true,
                hasMetallicTexture: true,
                hasReflectanceTexture: true,
                useOnlyMetallicFromTexture: true,
            },
        ],
    );
    assert.equal(
        result.cpp.match(/bbl::set_pbr_metallic_reflectance\(/g)?.length,
        3,
    );
    assert.ok(
        result.manifest.features.includes("material:metallic-reflectance"),
    );
});

test("accumulates repeated metallic-reflectance setter fields", () => {
    const result = compileSource(
        `
        import {
            createEngine,
            createPbrMaterial,
            createSolidTexture2D,
            loadTexture2D,
            setPbrMetallicReflectance,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const metallic = await loadTexture2D(
                engine,
                "/textures/nme/ebf71b300f43563f.png",
            );
            const reflectance = await loadTexture2D(
                engine,
                "/textures/nme/ebf71b300f43563f.png",
            );
            const material = createPbrMaterial({
                baseColorTexture: createSolidTexture2D(engine, 1, 1, 1),
                ormTexture: createSolidTexture2D(engine, 1, 0.5, 0),
            });
            setPbrMetallicReflectance(material, {
                texture: metallic,
                useOnlyMetallicFromTexture: true,
            });
            setPbrMetallicReflectance(material, {
                reflectanceTexture: reflectance,
            });
        }
    `,
        labDeployment,
    );

    assert.deepEqual(
        result.manifest.scenePbrMaterials[0]?.metallicReflectance,
        {
            hasColor: false,
            hasMetallicTexture: true,
            hasReflectanceTexture: true,
            useOnlyMetallicFromTexture: true,
        },
    );
    assert.equal(
        result.cpp.match(/bbl::set_pbr_metallic_reflectance\(/g)?.length,
        2,
    );
});

test("accepts an sRGB metallic-reflectance map and refuses unsupported setter inputs", () => {
    const compileSetter = (textureSetup: string, options: string) =>
        compileSource(
            `
        import {
            createEngine,
            createPbrMaterial,
            createSolidTexture2D,
            loadTexture2D,
            setPbrMetallicReflectance,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const material = createPbrMaterial({
                baseColorTexture: createSolidTexture2D(engine, 1, 1, 1),
                ormTexture: createSolidTexture2D(engine, 1, 0.5, 0),
            });
            ${textureSetup}
            setPbrMetallicReflectance(material, { ${options} });
        }
    `,
            labDeployment,
        );

    // An sRGB map is the pin's own combination: the texture's view decodes
    // and the pinned fragment raises the sample to 2.2 as well.
    assert.match(
        compileSetter(
            `const map = await loadTexture2D(
                engine,
                "/textures/nme/ebf71b300f43563f.png",
                { srgb: true },
            );`,
            "texture: map",
        ).cpp,
        /bbl::set_pbr_metallic_reflectance\(/,
    );
    assert.throws(
        () =>
            compileSetter(
                "const map = createSolidTexture2D(engine, 1, 1, 1);",
                "texture: map",
            ),
        /must come from loadTexture2D/,
    );
    for (const option of ["f0Factor: 0.5", "specularWeight: 0.5"]) {
        assert.throws(
            () => compileSetter("", option),
            /Reached metallic-reflectance lowering supports/,
        );
    }
    assert.throws(
        () =>
            compileSetter(
                "const value = Math.pow(0.5, 2.2);",
                "color: [value, value, value]",
            ),
        /color-only metallic-reflectance setter requires finite static RGB values/,
    );
});

test("keeps a complete snapshot when a const object is materialized then spread", () => {
    const result = compileSource(`
        interface Shared {
            radius: number;
            segments: number;
        }
        function consume(options: Shared): number {
            return options.radius + options.segments;
        }
        const shared = { radius: 0.05, segments: 1 } as const;
        const value = consume({ ...shared });
    `);

    assert.match(result.cpp, /0\.05/);
    assert.match(result.cpp, /1\.0/);
});

test("material stores through an effectful owner evaluate it once", () => {
    // `uvOffset`/`uvScale` write two record fields and `diffuseColor` binds
    // its owner for the setter: every statement names the owner, so an
    // index with effects is read once ahead of them.
    const result = compileSource(`
        import { createEngine, createStandardMaterial, type StandardMaterialProps } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const first = createStandardMaterial();
            const second = createStandardMaterial();
            const third = createStandardMaterial();
            interface Holder { mat: StandardMaterialProps }
            const holders: Holder[] = [{ mat: first }, { mat: second }, { mat: third }];
            let h = 0;
            holders[h++]!.mat.uvOffset = [5, 6];
            let d = 0;
            holders[d++]!.mat.diffuseColor = [0, 0, 1];
            let u = 0;
            holders[u++]!.mat.uvScale = [2, 2];
            const rig = { materials: [first, second, third] };
            let r = 0;
            rig.materials[r++]!.uvOffset = [r, r];
            let s = 0;
            rig.materials[s++ % 3]!.specularPower = 8;
            void engine;
        }
    `);
    for (const name of ["v_h", "v_d", "v_u", "v_r", "v_s"])
        assert.equal(
            result.cpp.split(`${name}++`).length - 1,
            1,
            `${name} is incremented once`,
        );
    assert.match(
        result.cpp,
        /const double (v_bblite_store_key_\d+) = \(v_r\+\+\);[^]*?standard_uv_offset_x = v_r;[^]*?standard_uv_offset_y = v_r;/,
    );
});

test("materializes a callback returned through its own closure cycle", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        function buildSelector(onSelect: (index: number) => void): (active: number) => void {
            const button = document.createElement("button");
            button.textContent = "Select";
            button.addEventListener("click", () => onSelect(1));
            document.body.appendChild(button);
            return (active) => {
                button.style.color = active > 0 ? "#fff" : "#000";
            };
        }

        async function main(): Promise<void> {
            await createEngine({});
            const update = buildSelector((index) => select(index));
            function select(index: number): void {
                update(index);
            }
            update(0);
        }

        void main();
    `);

    // `select` reads `update` from a closure its initializer creates, so the
    // binding is a temporal-dead-zone cell, initialized once the call returns.
    assert.match(
        result.cpp,
        /bbl::js::make_gc_shared<bbl::js::LexicalBinding<bbl::js::Callback<void\(double\)>>>/,
    );
    assert.match(result.cpp, /on_dom_pointer[^\n]*"click"/);
    assert.match(result.cpp, /ui_set_style_property/);
    // The shared select body forwards its runtime index to the cell's callback.
    assert.match(result.cpp, /bbl_recursive_fn\d+_group\)\(v_fn\d+_index\)/);
    assert.match(result.cpp, /snapshot_callback\(v_update->get\(\)\)/);
    assert.match(result.cpp, /v_update->initialize\(/);
    assert.doesNotMatch(result.cpp, /on_dom_pointer[^\n]*v_update\(1\.0\)/);
});

const instancedShaderSource = (extra: string) => `
    import {
        createBox,
        createEngine,
        createShaderMaterial,
        setThinInstanceColors,
        setThinInstances,
    } from "@babylonjs/lite";

    const vertexSource = \`struct VertexOutput{@builtin(position) position:vec4<f32>,};
@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;let iw=mat4x4<f32>(input.world0,input.world1,input.world2,input.world3);out.position=shaderSystem.viewProjection*(shaderSystem.world*iw)*vec4<f32>(input.position,1.0);return out;}\`;
    const fragmentSource = \`struct VertexOutput{@builtin(position) position:vec4<f32>,};
@fragment fn mainFragment(input:VertexOutput)->@location(0) vec4<f32>{return vec4<f32>(1.0);}\`;

    async function main() {
        const engine = await createEngine(document.createElement("canvas"));
        const material = createShaderMaterial({
            vertexSource,
            fragmentSource,
            attributes: ["position"],
            uniforms: ["viewProjection", "world"],
        });
        const box = createBox(engine);
        box.material = material;
        setThinInstances(box, new Float32Array(16), 1);
${extra}
    }
`;

test("names a scene-local shader material the reach order gives it", () => {
    // The pin's `name` is optional and it composes nothing from it, so a
    // scene that names nothing still gets a variant identity.
    const [program] = compileSource(instancedShaderSource("")).manifest
        .customShaderPrograms;

    assert.equal(program?.name, "scene-shader-0");
});

test("declares a shader material's instance lanes from the mesh", () => {
    // The pin reads the MESH for both lanes -- `mesh.thinInstances` for the
    // matrices and `!!ti.colors` for the colour. A colour lane the source
    // never reads changes nothing it draws, so only a reading source takes it.
    const [plain] = compileSource(instancedShaderSource("")).manifest
        .customShaderPrograms;
    const [colored] = compileSource(
        instancedShaderSource(
            "        setThinInstanceColors(box, new Float32Array(4));",
        ),
    ).manifest.customShaderPrograms;
    const [reading] = compileSource(
        instancedShaderSource(
            "        setThinInstanceColors(box, new Float32Array(4));",
        ).replace(
            "out.position=",
            "let tint=input.instanceColor;out.position=",
        ),
    ).manifest.customShaderPrograms;

    assert.equal(plain?.useThinInstances, true);
    assert.equal(plain?.useThinInstanceColors, undefined);
    assert.equal(colored?.useThinInstances, true);
    assert.equal(colored?.useThinInstanceColors, undefined);
    assert.equal(reading?.useThinInstanceColors, true);
});

test("leaves a line material's own instanced form alone", () => {
    // The line family settles both flags from its own options and names the
    // permutation, so the mesh-driven settlement must not reach it.
    const [program] = compileSource(`
        import {
            createBox,
            createEngine,
            createLineMaterial,
            setThinInstances,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine(document.createElement("canvas"));
            const box = createBox(engine);
            box.material = createLineMaterial({
                color: { r: 1, g: 0, b: 0, a: 1 },
            });
            setThinInstances(box, new Float32Array(16), 1);
        }
    `).manifest.customShaderPrograms;

    assert.equal(program?.name, "line-material");
    assert.equal(program?.useThinInstances, false);
});

test("refuses one shader material drawn both instanced and plain", () => {
    // The lanes are declared in the prelude the stage compiles against, so
    // upstream this is two pipelines; one baked variant cannot be both.
    assert.throws(
        () =>
            compileSource(
                instancedShaderSource(
                    "        const plain = createBox(engine);\n" +
                        "        plain.material = material;",
                ),
            ),
        /disagree about thin instances/,
    );
});

test("lays a lane-reading shader material out only where a possible mesh has the lanes", () => {
    // A value naming one of several meshes may land the material on any of
    // them; a plain one cannot draw the program (the pin's plain prelude
    // declares no lanes), so the draw checks the mesh it lands on.
    const { manifest } = compileSource(
        instancedShaderSource(
            "        const plain = createBox(engine);\n" +
                "        const meshes = [box, plain];\n" +
                "        for (const mesh of meshes) if (mesh !== plain) mesh.material = material;",
        ),
    );
    const [program] = manifest.customShaderPrograms;
    const variants = manifest.sceneMeshes.map(
        (mesh) => mesh.shaderVariants ?? [mesh.shaderVariant],
    );
    assert.deepEqual(variants, [["scene-shader-0"], [undefined]]);
    assert.equal(program?.useThinInstances, true);
    assert.equal(program?.runtimeInstanceLayoutCheck, true);
});

test("composes a lane-reading shader material an unknown assignment puts on loaded meshes", () => {
    // No scene mesh lays the program out, yet a loaded mesh may draw it; the
    // lanes its source reads are the only form it can draw with.
    const vertex =
        "struct VertexOutput{@builtin(position) position:vec4<f32>,};\\n" +
        "@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;" +
        "let iw=mat4x4<f32>(input.world0,input.world1,input.world2,input.world3);" +
        "out.position=shaderSystem.viewProjection*(shaderSystem.world*iw)*vec4<f32>(input.position,1.0);" +
        "out.position.w=out.position.w+input.instanceColor.a*0.0;return out;}";
    const fragment =
        "struct VertexOutput{@builtin(position) position:vec4<f32>,};\\n" +
        "@fragment fn mainFragment(input:VertexOutput)->@location(0) vec4<f32>{return vec4<f32>(1.0);}";
    const [program] = compileSource(`
        import { createEngine, createShaderMaterial, getContainerMeshes, loadGltf, type ShaderMaterial } from "@babylonjs/lite";
        interface Surface { material: ShaderMaterial }
        function surfaces(): Surface[] {
            return [{ material: createShaderMaterial({ vertexSource: "${vertex}", fragmentSource: "${fragment}", attributes: ["position"], uniforms: ["viewProjection", "world"] }) }];
        }
        async function main() {
            const engine = await createEngine(document.createElement("canvas"));
            const container = await loadGltf(engine, "model.glb");
            const sets = surfaces();
            for (const mesh of getContainerMeshes(container)) mesh.material = sets[0]!.material;
        }
    `).manifest.customShaderPrograms;
    assert.equal(program?.drawReachable, true);
    assert.equal(program?.useThinInstances, true);
    assert.equal(program?.useThinInstanceColors, true);
    assert.equal(program?.runtimeInstanceLayoutCheck, true);
});

test("gives a lane-reading shader material no plain layout from an unknown assignment", () => {
    // A run-time material choice may name the program on a plain mesh; with
    // no mesh holding its lanes it has no drawable layout there, and a draw
    // that lands on one refuses at run time.
    const { manifest } = compileSource(
        instancedShaderSource(
            "        const plain = createBox(engine);\n" +
                "        plain.material = performance.now() > 1e15 ? material : createStandardMaterial();",
        )
            .replace("box.material = material;", "")
            .replace(
                "createShaderMaterial,",
                "createShaderMaterial,\n        createStandardMaterial,",
            ),
    );
    const [program] = manifest.customShaderPrograms;
    assert.deepEqual(
        manifest.sceneMeshes.map((mesh) => mesh.shaderVariants ?? []),
        [[], []],
    );
    assert.equal(program?.runtimeInstanceLayoutCheck, true);
});

test("carries explicit alpha blending and mesh render order", () => {
    const result = compileSource(`
        import {
            createBox,
            createEngine,
            createPbrMaterial,
            createSolidTexture2D,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const mesh = createBox(engine);
            mesh.material = createPbrMaterial({
                baseColorTexture: createSolidTexture2D(engine, 1, 1, 1),
                ormTexture: createSolidTexture2D(engine, 1, 1, 1),
                baseColorFactor: [0.25, 0.5, 0.75, 0.5],
                alphaBlend: true,
            });
            mesh.renderOrder = 7;
        }
    `);

    assert.match(
        result.cpp,
        /\.base_color_factor = bbl::Color4\{0\.25f, 0\.5f, 0\.75f, 0\.5f\}/,
    );
    assert.match(result.cpp, /\.alpha_blend = true/);
    assert.match(result.cpp, /\.render_order = 7\.0/);
    assert.match(result.cpp, /\.has_render_order = true/);
});

test("compiles pinned scene 213 GridMaterial options", () => {
    const source = readFileSync(
        resolve("corpus/babylon-lite/lab/lite/src/lite/scene213.ts"),
        "utf8",
    );
    const result = compileSource(source, {
        fileName: "corpus/babylon-lite/lab/lite/src/lite/scene213.ts",
    });

    // The pin's grid is a ShaderMaterial its factory builds from the
    // options; generation ran that factory, so each grid is a reached
    // shader program whose sources are the factory's own.
    assert.ok(result.manifest.features.includes("material:shader"));
    assert.ok(result.manifest.features.includes("renderer:scene"));
    const grids = result.manifest.customShaderPrograms.filter(({ name }) =>
        name.startsWith("grid-material-"),
    );
    // Four materials, four option sets: antialiased, max-line,
    // transparent and hard-cutoff.
    assert.equal(grids.length, 4);
    for (const grid of grids) {
        assert.match(grid.fragmentSource, /fn gridIsOnLine\(/);
        assert.deepEqual(grid.attributes, ["position", "normal"]);
        assert.deepEqual(grid.uniforms.slice(0, 3), [
            "world",
            "view",
            "projection",
        ]);
    }
    const transparent = grids.filter(
        ({ needAlphaBlending }) => needAlphaBlending,
    );
    assert.equal(transparent.length, 1);
    assert.match(
        transparent[0]!.fragmentSource,
        /opacity=clamp\(grid,0\.08,shaderUniforms\.gridControl\.w\*grid\);/,
    );
    assert.equal(transparent[0]!.depthWrite, false);
    // The factory's own computed values: Math.round over the frequency,
    // normalized to float32 by the material.
    assert.match(
        result.cpp,
        /bbl::set_shader_uniform_value\([^;]*0u, 0\.5f, 4\.0f, 0\.4f, 0\.6f\);/,
    );
    assert.match(result.cpp, /bbl::create_shader_material\(/);
});

test("refuses a GridMaterial option generation cannot fold", () => {
    assert.throws(
        () =>
            compileSource(
                `import { createEngine, createGridMaterial } from "@babylonjs/lite";
async function main() {
    const engine = await createEngine(document.getElementById("c") as HTMLCanvasElement);
    createGridMaterial({ gridRatio: Math.random() });
}
main();`,
            ),
        /GridMaterial option 'gridRatio' must be a static number/,
    );
});

test("compiles Babylon Lite scene 10 PBR rough sphere", () => {
    const source = readFileSync(
        resolve("corpus/babylon-lite/lab/lite/src/lite/scene10.ts"),
        "utf8",
    );
    const result = compileSource(source, {
        fileName: "corpus/babylon-lite/lab/lite/src/lite/scene10.ts",
    });

    assert.deepEqual(result.manifest.features, [
        "core",
        "backend:sdl",
        "camera:arc-rotate",
        "light:hemispheric",
        "material:pbr",
        "mesh:sphere",
        "texture:file",
        "renderer:scene",
    ]);
    assert.deepEqual(result.manifest.runtimeSources, [
        "src/pal.cpp",
        "src/pal_sdl.cpp",
        "src/pal_image.cpp",
        "src/pal_sdl_gpu.cpp",
    ]);
    assert.deepEqual(result.manifest.assets, []);
    assert.match(result.cpp, /bbl::create_solid_texture/);
    assert.match(result.cpp, /bbl::create_pbr_material/);
    assert.match(result.cpp, /bbl::create_sphere/);
    assert.match(
        result.cpp,
        /bbl::set_mesh_material\(v_engine, v_sphere, bbl::create_pbr_material\(/,
    );
    assert.deepEqual(result.manifest.generatedSources, [
        "upstream/src/engine.cpp",
        "upstream/src/scene_core.cpp",
        "upstream/src/variant_data.cpp",
        "upstream/src/camera_arc_rotate.cpp",
        "upstream/src/camera_controls.cpp",
        "upstream/src/light_matrix.cpp",
        "upstream/src/light_hemispheric.cpp",
        "upstream/src/renderer_plan.cpp",
        "upstream/src/material_pbr.cpp",
        "upstream/src/texture_file.cpp",
        "upstream/src/mesh_factories.cpp",
    ]);
});

test("compiles Babylon Lite scene 176 transmission, IOR, and volume", () => {
    const sourcePath = "corpus/babylon-lite/lab/lite/src/lite/scene176.ts";
    const result = compileSource(readFileSync(resolve(sourcePath), "utf8"), {
        fileName: sourcePath,
    });

    assert.ok(result.manifest.features.includes("renderer:transmission"));
    assert.match(result.cpp, /bbl::enable_scene_transmission/);
    assert.match(
        result.cpp,
        /bbl::on_before_render\([^\n]*make_closure\(bblscene::bbl_environment_\w+\{[^}\n]*std::ref\(v_engine\)[^}\n]*\}, bblscene::\w+/,
    );
    // The amber body's transmission, IOR, volume, and skybox-mode
    // material state arrive through the glTF loader; the scene's own
    // PBR material carries the skybox-mode backdrop.
    assert.match(result.cpp, /bbl::create_pbr_material\(/);
    assert.ok(
        result.manifest.assets.some(({ output }) => /\.glb$/.test(output)),
    );
});

test("compiles Babylon Lite scene 273 runtime material-family addition", () => {
    const source = readFileSync(
        resolve("corpus/babylon-lite/lab/lite/src/lite/scene273.ts"),
        "utf8",
    );
    const result = compileSource(source, {
        fileName: "corpus/babylon-lite/lab/lite/src/lite/scene273.ts",
    });

    assert.deepEqual(result.manifest.features, [
        "core",
        "backend:sdl",
        "engine:device-recovery",
        "camera:arc-rotate",
        "light:hemispheric",
        "material:pbr",
        "material:standard",
        "mesh:box",
        "mesh:ground",
        "texture:file",
        "renderer:scene",
    ]);
    assert.match(result.cpp, /\.fixed_delta_ms = 16\.0;/);
    assert.match(result.cpp, /bbl::on_before_render/);
    assert.match(result.cpp, /v_frame\+\+/);
    assert.match(result.cpp, /if \(\(!\(v_added\) && v_frame >= 20\.0\)\)/);
    assert.match(
        result.cpp,
        /\.metallic_factor = 0\.1f, \.roughness_factor = 0\.4f, \.direct_intensity = 1\.0f/,
    );
    // The frame threshold, a sum of two constants, folds.
    assert.match(result.cpp, /if \(\(v_added && v_frame >= 170\.0\)\)/);
    assert.doesNotMatch(result.cpp, /dataset|drawCallCount/);
    assert.deepEqual(result.manifest.generatedSources, [
        "upstream/src/engine.cpp",
        "upstream/src/device_recovery.cpp",
        "upstream/src/scene_core.cpp",
        "upstream/src/variant_data.cpp",
        "upstream/src/camera_arc_rotate.cpp",
        "upstream/src/camera_controls.cpp",
        "upstream/src/light_matrix.cpp",
        "upstream/src/light_hemispheric.cpp",
        "upstream/src/renderer_plan.cpp",
        "upstream/src/material_pbr.cpp",
        "upstream/src/texture_file.cpp",
        "upstream/src/material_standard.cpp",
        "upstream/src/mesh_factories.cpp",
    ]);
});

test("compiles Babylon Lite scene 267 Standard vertex colors", () => {
    const source = readFileSync(
        resolve("corpus/babylon-lite/lab/lite/src/lite/scene267.ts"),
        "utf8",
    );
    const result = compileSource(source, {
        fileName: "corpus/babylon-lite/lab/lite/src/lite/scene267.ts",
    });

    assert.deepEqual(result.manifest.features, [
        "core",
        "backend:sdl",
        "camera:arc-rotate",
        "material:standard",
        "material:standard-vertex-colors",
        "mesh:from-data",
        "renderer:scene",
    ]);
    // The RGBA colors ride the ninth createMeshFromData slot, after the
    // three optional typed arrays the scene skips with `undefined`.
    const colors =
        /bbl::js::F32Array (\w+) = bbl::js::f32_array_from\(bbl::js::Array<double>\{0\.0, 0\.0, 1\.0, 1\.0, 1\.0, 0\.0, 1\.0, 1\.0, 0\.0, 1\.0, 0\.0, 1\.0, 1\.0, 1\.0, 0\.0, 1\.0\}\);/.exec(
            result.cpp,
        );
    assert.ok(colors);
    const colorStream = new RegExp(
        `auto (\\w+) = bbl::js::Nullable<bbl::js::F32Array>\\{${colors[1]}\\};`,
    ).exec(result.cpp);
    assert.ok(colorStream);
    assert.match(
        result.cpp,
        new RegExp(
            `create_retained_mesh_from_data\\([^;]*std::nullopt, std::nullopt, std::nullopt, ${colorStream[1]}\\.to_optional\\(\\)\\)`,
        ),
    );
    assert.match(result.cpp, /\.disable_lighting = true;/);
    assert.match(result.cpp, /\.double_sided = !\(false\);/);
    // enableStandardVertexColors installs a shader fragment upstream, so
    // it reaches the feature and emits no statement.
    assert.doesNotMatch(result.cpp, /vertex_colors/);
    assert.deepEqual(result.manifest.generatedSources, [
        "upstream/src/engine.cpp",
        "upstream/src/scene_core.cpp",
        "upstream/src/variant_data.cpp",
        "upstream/src/camera_arc_rotate.cpp",
        "upstream/src/camera_controls.cpp",
        "upstream/src/renderer_plan.cpp",
        "upstream/src/material_standard.cpp",
        "upstream/src/mesh_factories.cpp",
    ]);
});

test("compiles Babylon Lite scene 274 alpha to coverage", () => {
    const source = readFileSync(
        resolve("corpus/babylon-lite/lab/lite/src/lite/scene274.ts"),
        "utf8",
    );
    const result = compileSource(source, {
        fileName: "corpus/babylon-lite/lab/lite/src/lite/scene274.ts",
    });

    assert.ok(result.manifest.features.includes("material:shader"));
    assert.ok(result.manifest.features.includes("mesh:plane"));
    assert.ok(result.manifest.features.includes("renderer:scene"));
    assert.match(result.cpp, /bbl::create_shader_material/);
    assert.match(result.cpp, /bbl::set_alpha_to_coverage/);
    assert.match(result.cpp, /bbl::create_plane/);
    // A reached program is the scene's own, named by its `name`.
    assert.deepEqual(result.manifest.shaderVariants, ["a2c-card"]);
    assert.deepEqual(
        result.manifest.customShaderPrograms.map(({ name }) => name),
        ["a2c-card"],
    );
    assert.match(result.cpp, /bbl::create_shader_material\(v_engine, 0u\)/);
    assert.ok(
        result.manifest.generatedSources.includes(
            "upstream/src/material_shader.cpp",
        ),
    );
});

test("compiles Babylon Lite scene 163 shader alpha cutout", () => {
    const source = readFileSync(
        resolve("corpus/babylon-lite/lab/lite/src/lite/scene163.ts"),
        "utf8",
    );
    const result = compileSource(source, {
        fileName: "corpus/babylon-lite/lab/lite/src/lite/scene163.ts",
    });

    assert.ok(result.manifest.features.includes("camera:arc-rotate"));
    assert.ok(result.manifest.features.includes("material:shader"));
    assert.ok(result.manifest.features.includes("mesh:plane"));
    assert.ok(result.manifest.features.includes("renderer:scene"));
    assert.deepEqual(result.manifest.shaderVariants, ["scene163-shader"]);
    assert.deepEqual(
        result.manifest.customShaderPrograms.map(({ name }) => name),
        ["scene163-shader"],
    );
    assert.match(result.cpp, /bbl::create_shader_material\(v_engine, 0u\)/);
    assert.match(result.cpp, /bbl::PlaneOptions\{3\.0f, 3\.0f\}/);
    assert.ok(
        result.manifest.adaptations.some(
            ({ id }) => id === "typed-reached-shader-variants",
        ),
    );
});

const SHADER_SAMPLER_SOURCE = (
    options: string,
    fragmentBody: string,
): string => `
    import {
        addToScene,
        createEngine,
        createPlane,
        createSceneContext,
        createShaderMaterial,
        createSolidTexture2D,
        loadTexture2D,
        registerScene,
        setShaderTexture,
        startEngine,
    } from "@babylonjs/lite";

    const vertexSource = \`struct VertexOutput{@builtin(position) position:vec4<f32>,@location(0) uv:vec2<f32>,};
@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;out.position=shaderSystem.worldViewProjection*vec4<f32>(input.position,1.0);out.uv=input.uv;return out;}\`;
    const fragmentSource = \`struct VertexOutput{@builtin(position) position:vec4<f32>,@location(0) uv:vec2<f32>,};
@fragment fn mainFragment(input:VertexOutput)->@location(0) vec4<f32>{${fragmentBody}}\`;

    async function main() {
        const engine = await createEngine({});
        const scene = createSceneContext(engine);
        const material = createShaderMaterial({
            name: "probe",
            vertexSource,
            fragmentSource,
            attributes: ["position", "uv"],
            uniforms: ["worldViewProjection"],
            ${options}
        });
        ${options.includes("samplers") ? 'setShaderTexture(material, "albedo", await loadTexture2D(engine, "/textures/nme/ebf71b300f43563f.png"));' : ""}
        const plane = createPlane(engine, { width: 1, height: 1 });
        plane.material = material;
        addToScene(scene, plane);
        await registerScene(scene);
        await startEngine(engine);
    }
`;

test("a shader material's sampler list mapped by a call is the names that call computes", () => {
    // The mapped part has no element to spell: the call runs at
    // generation over the module's own list.
    const source = SHADER_SAMPLER_SOURCE(
        `samplers: [...BINDINGS.map(([, name]) => name), ...(Date.now() < 0 ? [] : BINDINGS.map(([, name]) => suffixed(name, "secondary")))],`,
        "return textureSample(albedo,albedoSampler,input.uv)+textureSample(albedoSecondary,albedoSecondarySampler,input.uv)*0.0;",
    ).replace(
        "async function main() {",
        `const BINDINGS = [["color", "albedo"]] as const;
    function suffixed(name: string, role: string): string { return name + role[0]!.toUpperCase() + role.slice(1); }
    async function main() {`,
    );
    assert.throws(
        () => compileSource(source, labDeployment),
        /Expected a static array literal/,
    );
    const settled = source.replace("Date.now() < 0", "false");
    const [program] = compileSource(settled, labDeployment).manifest
        .customShaderPrograms;
    assert.deepEqual(program?.samplers, ["albedo", "albedoSecondary"]);
});

test("reaches a shader material's samplers and defines", () => {
    const result = compileSource(
        SHADER_SAMPLER_SOURCE(
            `samplers: ["albedo"],
            defines: { TINT: true, Scale: 2 },`,
            "if(TINT){return textureSample(albedo,albedoSampler,input.uv)*Scale;}return vec4<f32>(1.0,0.0,0.0,1.0);",
        ),
        labDeployment,
    );
    const [program] = result.manifest.customShaderPrograms;
    assert.deepEqual(program?.samplers, ["albedo"]);
    // createShaderMaterial sorts the normalized set by name, and the
    // prelude emits it in that order.
    assert.deepEqual(program?.defines, [
        { name: "Scale", value: 2 },
        { name: "TINT", value: true },
    ]);
    // The slot the setter resolved is the declared index.
    assert.match(result.cpp, /bbl::set_shader_texture\([^)]*, 0u,/);
});

const NUMERIC_SOURCE_FACTORY = `
        import { createEngine, createShaderMaterial } from "babylon-lite";

        const vertexSource = (depthBias: number) => \`struct VertexOutput {
            @builtin(position) position: vec4<f32>,
        };
        const DEPTH_BIAS: f32 = \${depthBias.toExponential(6)};
        @vertex fn mainVertex(input: VertexInput) -> VertexOutput {
            var out: VertexOutput;
            out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0);
            out.position.z = out.position.z + DEPTH_BIAS / out.position.w;
            return out;
        }\`;
        const fragmentSource = \`@fragment fn mainFragment() -> @location(0) vec4<f32> {
            return vec4<f32>(1.0);
        }\`;

        function makeMaterial(depthBias = 0) {
            return createShaderMaterial({
                name: "numeric-source-factory",
                vertexSource: vertexSource(depthBias),
                fragmentSource,
                attributes: ["position"],
                uniforms: ["worldViewProjection"],
            });
        }

        async function main() {
            await createEngine({});
            makeMaterial();
        }
    `;

test("binds a numeric shader source factory default at its reached call", () => {
    const result = compileSource(NUMERIC_SOURCE_FACTORY);

    assert.match(
        result.manifest.customShaderPrograms[0]?.vertexSource ?? "",
        /shaderUniforms\.bblDynamicVertex0/,
    );
    assert.deepEqual(result.manifest.customShaderPrograms[0]?.uniforms, [
        "worldViewProjection",
        "bblDynamicVertex0:f32",
    ]);
    // A known number's uniform holds the number its spelling denotes.
    assert.match(
        result.cpp,
        /const std::array<float, 1> values\{0\.0f\}; bbl::initialize_shader_uniform_values\([^;]*, 0u, 1u, values\.data\(\)\);/,
    );
    // An omitted argument runs the default inside the shared helper.
    assert.match(result.cpp, /bblscene::bbl_recursive_fn\d+_group\)\(\)/);
});

test("reads a numeric shader source factory's run-time argument from a uniform", () => {
    const result = compileSource(
        NUMERIC_SOURCE_FACTORY.replace(
            "makeMaterial();",
            "makeMaterial(Math.random());",
        ),
    );

    // The module-scope constant is gone; its read reads the uniform, which
    // holds the number the spelled text denotes.
    const [program] = result.manifest.customShaderPrograms;
    assert.doesNotMatch(program?.vertexSource ?? "", /DEPTH_BIAS/);
    assert.match(
        program?.vertexSource ?? "",
        /out\.position\.z = out\.position\.z \+ shaderUniforms\.bblDynamicVertex0 \/ out\.position\.w;/,
    );
    assert.deepEqual(program?.uniforms, [
        "worldViewProjection",
        "bblDynamicVertex0:f32",
    ]);
    assert.match(
        result.cpp,
        /const std::array<float, 1> values\{static_cast<float>\(bbl::js::number_from_string\(bbl::js::number_to_exponential\([^;]*, 6\.0\)\)\)\}; bbl::initialize_shader_uniform_values\([^;]*, 0u, 1u, values\.data\(\)\);/,
    );
});

test("reads the pin's wgsl tag as the identity over a shader source", () => {
    // Since 1.27.0 the corpus tags its inline WGSL with the pin's `wgsl`
    // helper (the quake material's depth-bias factory, scene 162's
    // literals). The helper is the identity over its template, so a tagged
    // source folds exactly as the untagged one above: the factory's
    // formatter still becomes a dynamic uniform, and a tagged literal is
    // its text.
    const result = compileSource(`
        import { createEngine, createShaderMaterial } from "babylon-lite";
        import { wgsl } from "babylon-lite/shader/wgsl.js";

        const vertexSource = (depthBias: number) => wgsl\`struct VertexOutput {
            @builtin(position) position: vec4<f32>,
        };
        const DEPTH_BIAS: f32 = \${depthBias.toExponential(6)};
        @vertex fn mainVertex(input: VertexInput) -> VertexOutput {
            var out: VertexOutput;
            out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0);
            out.position.z = out.position.z + DEPTH_BIAS / out.position.w;
            return out;
        }\`;
        const fragmentSource = wgsl\`@fragment fn mainFragment() -> @location(0) vec4<f32> {
            return vec4<f32>(0.5);
        }\`;

        function makeMaterial(depthBias = 0) {
            return createShaderMaterial({
                name: "tagged-source-factory",
                vertexSource: vertexSource(depthBias),
                fragmentSource,
                attributes: ["position"],
                uniforms: ["worldViewProjection"],
            });
        }

        async function main() {
            await createEngine({});
            makeMaterial();
        }
    `);

    const [program] = result.manifest.customShaderPrograms;
    assert.match(
        program?.vertexSource ?? "",
        /shaderUniforms\.bblDynamicVertex0/,
    );
    assert.deepEqual(program?.uniforms, [
        "worldViewProjection",
        "bblDynamicVertex0:f32",
    ]);
    assert.match(program?.fragmentSource ?? "", /return vec4<f32>\(0\.5\);/);
    assert.ok(!(program?.fragmentSource ?? "").includes("wgsl"));
});

test("preserves shader-material identity through a typed class field", () => {
    const result = compileSource(`
        import {
            createEngine,
            createShaderMaterial,
            setShaderFloat,
            type ShaderMaterial,
        } from "babylon-lite";

        const vertexSource = \`struct VertexOutput {
            @builtin(position) position: vec4<f32>,
        };
        @vertex fn mainVertex(input: VertexInput) -> VertexOutput {
            var out: VertexOutput;
            out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0);
            return out;
        }\`;
        const fragmentSource = \`@fragment fn mainFragment() -> @location(0) vec4<f32> {
            return vec4<f32>(shaderUniforms.brightness);
        }\`;

        class MaterialOwner {
            private readonly material: ShaderMaterial;

            constructor() {
                this.material = createShaderMaterial({
                    name: "class-owned",
                    vertexSource,
                    fragmentSource,
                    attributes: ["position"],
                    uniforms: [
                        "worldViewProjection",
                        { name: "brightness", type: "f32", defaultValue: 1 },
                    ],
                });
                setShaderFloat(this.material, "brightness", 2.4);
            }
        }

        async function main() {
            await createEngine({});
            const owner = new MaterialOwner();
        }
    `);

    assert.deepEqual(result.manifest.shaderVariants, ["class-owned"]);
    assert.match(
        result.cpp,
        /bbl::set_scene_shader_uniform_value\([^;]*, 0u, 0u, 2\.4f\);/,
    );
});

test("preserves reached shader materials pushed inside a runtime loop", () => {
    const result = compileSource(`
        import {
            createEngine,
            createShaderMaterial,
            setShaderFloat,
            type ShaderMaterial,
        } from "babylon-lite";

        const vertexSource = \`struct VertexOutput {
            @builtin(position) position: vec4<f32>,
        };
        @vertex fn mainVertex(input: VertexInput) -> VertexOutput {
            var out: VertexOutput;
            out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0);
            return out;
        }\`;
        const fragmentSource = \`@fragment fn mainFragment() -> @location(0) vec4<f32> {
            return vec4<f32>(shaderUniforms.time);
        }\`;

        async function main() {
            await createEngine({});
            const materials: ShaderMaterial[] = [];
            const seeds = new Map<number, number>();
            seeds.set(0, 1);
            for (const [, seed] of seeds) {
                const material = createShaderMaterial({
                    name: "runtime-loop-material",
                    vertexSource,
                    fragmentSource,
                    attributes: ["position"],
                    uniforms: [
                        "worldViewProjection",
                        { name: "time", type: "f32", defaultValue: 0 },
                    ],
                });
                materials.push(material);
            }
            for (const material of materials) {
                setShaderFloat(material, "time", 2);
            }
        }
    `);

    assert.deepEqual(result.manifest.shaderVariants, ["runtime-loop-material"]);
    assert.match(
        result.cpp,
        /bbl::set_scene_shader_uniform_value\([^;]*, 0u, 0u, 2\.0f\);/,
    );
});

test("carries pixels textures through typed records and maps", () => {
    const result = compileSource(`
        import {
            createEngine,
            createShaderMaterial,
            createTexture2DFromPixels,
            setShaderTexture,
            type Texture2D,
        } from "babylon-lite";

        interface CachedImage {
            texture: Texture2D;
            width: number;
            height: number;
        }

        const vertexSource = \`struct VertexOutput{@builtin(position) position:vec4<f32>,};
@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;out.position=shaderSystem.worldViewProjection*vec4<f32>(input.position,1.0);return out;}\`;
        const fragmentSource = \`@fragment fn mainFragment()->@location(0) vec4<f32>{return textureSample(image,imageSampler,vec2<f32>(0.5));}\`;

        async function main() {
            const engine = await createEngine({});
            const images = new Map<string, CachedImage | null>();
            const texture = createTexture2DFromPixels(
                engine,
                new Uint8Array([255, 0, 0, 255]),
                1,
                1,
            );
            images.set("red", { texture, width: 1, height: 1 });
            const cached = images.get("red");
            if (!cached) throw new Error("missing image");
            const material = createShaderMaterial({
                name: "cached-pixels",
                vertexSource,
                fragmentSource,
                attributes: ["position"],
                uniforms: ["worldViewProjection"],
                samplers: ["image"],
            });
            setShaderTexture(material, "image", cached.texture);
        }
    `);

    assert.match(
        result.cpp,
        /bbl::js::Map<std::string, bblscene::CachedImage>/,
    );
    assert.match(result.cpp, /bbl::StoredTexture texture;/);
    assert.match(result.cpp, /bbl::set_shader_pixels_texture\(/);
});

test("lowers a pixels texture upload through a captured GPU device", () => {
    const result = compileSource(`
        import {
            createEngine,
            createTexture2DFromPixels,
        } from "babylon-lite";

        async function main() {
            const engine = await createEngine({});
            const pixels = new Uint8Array([255, 0, 0, 255]);
            const texture = createTexture2DFromPixels(engine, pixels, 1, 1);
            const device = engine._device;
            const upload = (): void => {
                device.queue.writeTexture(
                    { texture: texture.texture },
                    pixels as Uint8Array<ArrayBuffer>,
                    { bytesPerRow: 4, rowsPerImage: 1 },
                    { width: 1, height: 1 },
                );
            };
            requestAnimationFrame(upload);
        }
    `);

    assert.match(result.cpp, /bbl::update_pixels_texture\(/);
    assert.doesNotMatch(result.cpp, /writeTexture|\.queue/);
});

test("supports typed shader samplers and refuses shapes outside the reached slice", () => {
    const typedSampler = compileSource(
        SHADER_SAMPLER_SOURCE(
            `samplers: [{ name: "albedo", sampleType: "depth", viewDimension: "2d-array", comparison: true }],`,
            "return textureSampleCompare(albedo,albedoSampler,input.uv,0,0.5);",
        ),
        labDeployment,
    );
    assert.deepEqual(
        typedSampler.manifest.customShaderPrograms[0]?.samplerDeclarations,
        [
            {
                name: "albedo",
                sampleType: "depth",
                viewDimension: "2d-array",
                comparison: true,
            },
        ],
    );
    // SDL_GPU gives a vertex texture its own register space.
    const vertexSampler = compileSource(
        SHADER_SAMPLER_SOURCE(
            `samplers: ["albedo"],`,
            "return textureSample(albedo,albedoSampler,input.uv);",
        ).replace(
            "out.position=shaderSystem.worldViewProjection*vec4<f32>(input.position,1.0);",
            "out.position=shaderSystem.worldViewProjection*vec4<f32>(input.position,1.0)+textureSampleLevel(albedo,albedoSampler,input.uv,0.0);",
        ),
        labDeployment,
    );
    assert.match(
        vertexSampler.manifest.customShaderPrograms[0]!.vertexSource,
        /textureSampleLevel\(albedo,albedoSampler,input\.uv,0\.0\)/,
    );
    // The pin reserves both halves of the generated pair.
    assert.throws(
        () =>
            compileSource(
                SHADER_SAMPLER_SOURCE(
                    `samplers: ["albedo"],
                    defines: { albedoSampler: true },`,
                    "return textureSample(albedo,albedoSampler,input.uv);",
                ),
                labDeployment,
            ),
        /collides with another generated identifier/,
    );
    // A define carries a static boolean or number and nothing else.
    assert.throws(
        () =>
            compileSource(
                SHADER_SAMPLER_SOURCE(
                    `defines: { TINT: "yes" },`,
                    "if(TINT){return vec4<f32>(1.0,0.0,0.0,1.0);}return vec4<f32>(0.0,0.0,0.0,1.0);",
                ),
                labDeployment,
            ),
        /Expected a static numeric literal/,
    );
});

test("compiles shader variants through parsed WGSL IR", () => {
    const source = readFileSync(
        resolve("corpus/babylon-lite/lab/lite/src/lite/scene163.ts"),
        "utf8",
    ).replace(
        "struct VertexOutput {",
        "// Semantically irrelevant shader comment.\nstruct VertexOutput\n{",
    );
    const result = compileSource(source, {
        fileName: "corpus/babylon-lite/lab/lite/src/lite/scene163.ts",
    });

    assert.deepEqual(result.manifest.shaderVariants, ["scene163-shader"]);
});

test("reports invalid reached WGSL at the shader options", () => {
    const source = readFileSync(
        resolve("corpus/babylon-lite/lab/lite/src/lite/scene163.ts"),
        "utf8",
    ).replace("if(distance(input.uv,vec2<f32>(0.5,0.5))<0.18)", "if()");

    assert.throws(
        () =>
            compileSource(source, {
                fileName: "corpus/babylon-lite/lab/lite/src/lite/scene163.ts",
            }),
        /corpus\/babylon-lite\/lab\/lite\/src\/lite\/scene163\.ts:\d+:\d+: Invalid reached shader material WGSL:/,
    );
});

test("compiles shader materials inside a frame-graph render task", () => {
    const source = readFileSync(
        resolve("examples/audit-shader-frame-graph.ts"),
        "utf8",
    );
    const result = compileSource(source, {
        fileName: "examples/audit-shader-frame-graph.ts",
    });

    assert.ok(result.manifest.features.includes("material:shader"));
    assert.ok(result.manifest.features.includes("renderer:geometry-output"));
    assert.deepEqual(result.manifest.shaderVariants, [
        "audit-card",
        "audit-cutout",
    ]);
    assert.match(result.cpp, /create_render_task/);
    assert.match(result.cpp, /add_task/);
});

test("compiles Babylon Lite scene 116 no-color depth views", () => {
    const source = readFileSync(
        resolve("corpus/babylon-lite/lab/lite/src/lite/scene116.ts"),
        "utf8",
    );
    const result = compileSource(source, {
        fileName: "corpus/babylon-lite/lab/lite/src/lite/scene116.ts",
    });

    assert.ok(result.manifest.features.includes("material:no-color-view"));
    assert.ok(result.manifest.features.includes("mesh:torus"));
    assert.ok(result.manifest.features.includes("renderer:geometry-output"));
    assert.match(result.cpp, /bbl::create_render_target_texture/);
    assert.match(result.cpp, /bbl::create_torus/);
    assert.match(result.cpp, /bbl::create_standard_no_color_material_view/);
    assert.match(result.cpp, /bbl::create_pbr_no_color_material_view/);
    assert.match(result.cpp, /bbl::add_render_task_mesh/);
    // 1.23 moved the Standard emissive texture behind its own setter; the
    // scene calls that, and the record write is inside it.
    assert.match(result.cpp, /bbl::set_standard_emissive_texture/);
    assert.match(
        result.cpp,
        /RenderTaskOptions\{"standard-shadow-depth"[\s\S]*v_standardDepthCamera, true, true/,
    );
    assert.match(
        result.cpp,
        /RenderTaskOptions\{"default-render-task"[\s\S]*CameraHandle\{\}, false, true, true, true\}/,
        "the compiler-owned default task must retain the scene background stages",
    );
    assert.ok(
        result.manifest.generatedSources.includes(
            "upstream/src/material_views.cpp",
        ),
    );
    assert.ok(
        result.manifest.generatedSources.includes(
            "upstream/src/frame_graph_geometry.cpp",
        ),
    );
    assert.ok(
        result.manifest.adaptations.some(
            ({ id }) => id === "readable-default-render-task",
        ),
    );
});

test("compiles a scene-less uniform-effect frame graph without the scene renderer", () => {
    const fileName = "corpus/babylon-lite/lab/lite/src/demos/torus-states.ts";
    const source = readFileSync(resolve(fileName), "utf8");
    const result = compileSource(source, { fileName });

    assert.deepEqual(result.manifest.features, [
        "core",
        "backend:sdl",
        "frame-graph:resources",
        "renderer:frame-graph",
        "effect:wrapper",
        "effect:task",
        "renderer:post-process",
    ]);
    assert.deepEqual(result.manifest.runtimeSources, [
        "src/pal.cpp",
        "src/pal_sdl.cpp",
        "src/pal_image.cpp",
        "src/pal_sdl_gpu_frame_graph.cpp",
    ]);
    assert.ok(
        result.manifest.generatedSources.includes(
            "upstream/src/frame_graph_resources.cpp",
        ),
    );
    assert.ok(
        result.manifest.generatedSources.includes(
            "upstream/src/frame_graph_context.cpp",
        ),
    );
    assert.ok(!result.manifest.features.includes("renderer:scene"));
    assert.ok(!result.manifest.features.includes("renderer:geometry-output"));
    assert.doesNotMatch(result.cmake, /pal_sdl_gpu\.cpp/);
    assert.match(result.cpp, /bbl::create_frame_graph_context/);
    assert.match(result.cpp, /bbl::on_frame_graph_update/);
    assert.match(
        result.cpp,
        /auto v_from = bbl::js::make_gc_shared<bblscene::MorphState>\(bbl::js::array_at_or_default\(v_STATES, /,
    );
    assert.match(
        result.cpp,
        /bbl::js::Array<bblscene::MorphState> v_STATES = /,
    );
});

test("compiles Babylon Lite scene 249 vertex alpha clip", () => {
    const source = readFileSync(
        resolve("corpus/babylon-lite/lab/lite/src/lite/scene249.ts"),
        "utf8",
    );
    const result = compileSource(source, {
        fileName: "corpus/babylon-lite/lab/lite/src/lite/scene249.ts",
    });
    const asset = result.manifest.assets.find(({ kind }) => kind === "gltf");
    assert.match(asset?.source ?? "", /VertexColorAlphaClipTest\.gltf$/);
    assert.equal(asset?.output.endsWith(".glb"), true);
    assert.ok(result.manifest.features.includes("loader:gltf"));
    assert.ok(result.manifest.features.includes("renderer:scene"));
});

test("a shader material draws a mesh whose optional streams are decided at run time", () => {
    // The pin binds a zero buffer for a declared stream the mesh lacks, so
    // the shader program does not depend on which streams the run passes;
    // a Standard material's variant key still does.
    const compile = (material: string) =>
        compileSource(`
        import { addToScene, createEngine, createMeshFromData, createSceneContext, createShaderMaterial, createStandardMaterial } from "@babylonjs/lite";
        const vertexSource = \`struct VertexOutput{@builtin(position) position:vec4<f32>,};
@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;out.position=shaderSystem.worldViewProjection*vec4<f32>(input.position,1.0);return out;}\`;
        const fragmentSource = \`struct VertexOutput{@builtin(position) position:vec4<f32>,};
@fragment fn mainFragment(input:VertexOutput)->@location(0) vec4<f32>{return vec4<f32>(1.0);}\`;
        const engine = await createEngine({});
        const scene = createSceneContext(engine);
        let uv2: Float32Array | null = null;
        if (Math.random() > 0.5) uv2 = new Float32Array(2);
        const colors = Math.random() > 0.5 ? new Float32Array(4) : undefined;
        const mesh = createMeshFromData(engine, "patch", new Float32Array([0, 0, 0]), new Float32Array([0, 1, 0]), new Uint32Array([0]), new Float32Array(2), uv2!, undefined, colors);
        mesh.material = ${material};
        addToScene(scene, mesh);
        void createShaderMaterial; void createStandardMaterial; void vertexSource; void fragmentSource;
    `);
    const result = compile(
        `createShaderMaterial({ vertexSource, fragmentSource, attributes: ["position", "uv2", "color"], uniforms: ["worldViewProjection"] })`,
    );
    assert.match(result.cpp, /runtime_attribute_features = true/);
    assert.match(result.cpp, /bbl::set_mesh_material\(/);
    assert.throws(
        () => compile("createStandardMaterial()"),
        /optional vertex streams are decided at run time/,
    );
});

test("a material the pin types ShaderMaterial draws a mesh with run-time streams wherever it was read from", () => {
    // A record field holds the material, so its value carries no shader
    // variant of its own; its type still names the shader family.
    const result = compileSource(`
        import { addToScene, createEngine, createMeshFromData, createSceneContext, createShaderMaterial, type ShaderMaterial } from "@babylonjs/lite";
        const vertexSource = \`struct VertexOutput{@builtin(position) position:vec4<f32>,};
@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;out.position=shaderSystem.worldViewProjection*vec4<f32>(input.position,1.0);return out;}\`;
        const fragmentSource = \`struct VertexOutput{@builtin(position) position:vec4<f32>,};
@fragment fn mainFragment(input:VertexOutput)->@location(0) vec4<f32>{return vec4<f32>(1.0);}\`;
        const engine = await createEngine({});
        const scene = createSceneContext(engine);
        interface MaterialSet { material: ShaderMaterial }
        let set: MaterialSet | undefined;
        const build = (uvs: Float32Array | undefined): void => {
            set = { material: createShaderMaterial({ vertexSource, fragmentSource, attributes: ["position", "uv"], uniforms: ["worldViewProjection"] }) };
            const mesh = createMeshFromData(engine, "crown", new Float32Array([0, 0, 0]), new Float32Array([0, 1, 0]), new Uint32Array([0]), uvs, Math.random() > 0.5 ? new Float32Array(2) : undefined);
            (mesh as unknown as { material: unknown }).material = set.material;
            addToScene(scene, mesh);
        };
        build(Math.random() > 0.5 ? new Float32Array(2) : undefined);
    `);
    assert.match(result.cpp, /runtime_attribute_features = true/);
    assert.match(result.cpp, /bbl::set_mesh_material\(/);
});

test("compiles Babylon Lite scene 216 PBR fog", () => {
    const source = readFileSync(
        resolve("corpus/babylon-lite/lab/lite/src/lite/scene216.ts"),
        "utf8",
    );
    const result = compileSource(source, {
        fileName: "corpus/babylon-lite/lab/lite/src/lite/scene216.ts",
    });
    assert.ok(result.manifest.features.includes("renderer:fog"));
    assert.ok(result.manifest.features.includes("renderer:scene"));
    assert.match(
        result.cpp,
        /bbl::set_scene_fog\(v_scene, 3\.0f, 0\.0f, 12\.0f, 60\.0f, bbl::Color3\{0\.7f, 0\.75f, 0\.82f\}\)/,
    );
});

test("compiles Babylon Lite scene 3 Standard fog and image skybox", () => {
    const source = readFileSync(
        resolve("corpus/babylon-lite/lab/lite/src/lite/scene3.ts"),
        "utf8",
    );
    const result = compileSource(source, {
        fileName: "corpus/babylon-lite/lab/lite/src/lite/scene3.ts",
    });
    assert.ok(result.manifest.features.includes("renderer:fog"));
    assert.ok(result.manifest.features.includes("material:standard"));
    assert.ok(result.manifest.features.includes("background:image-skybox"));
    assert.ok(
        result.manifest.generatedSources.includes(
            "upstream/src/image_skybox.cpp",
        ),
    );
    const faces = result.manifest.assets.filter(({ source: url }) =>
        /skybox_[pn][xyz]\.jpg$/.test(url),
    );
    assert.equal(faces.length, 6);
    assert.match(
        result.cpp,
        /bbl::set_scene_fog\(v_scene, 1\.0f, 0\.02f, 0\.0f, 1000\.0f, bbl::Color3\{0\.9f, 0\.9f, 0\.85f\}\)/,
    );
    assert.match(result.cpp, /bbl::load_image_skybox\(v_scene, /);
});

test("compiles fog with an HDR environment skybox", () => {
    const result = compileSource(
        `
        import {
            createEngine,
            createSceneContext,
            loadHdrEnvironment,
            setFog,
        } from "babylon-lite";

        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            await loadHdrEnvironment(scene, "/track.hdr", {
                faceSize: 512,
                useCubemapSkybox: true,
                skyboxSize: 1000,
                skyboxPosition: [0, 0, 0],
                skipGround: true,
            });
            setFog(scene, {
                mode: 3,
                density: 0,
                start: 50,
                end: 800,
                color: [0.1, 0.2, 0.3],
            });
        }
    `,
        labDeployment,
    );

    assert.ok(result.manifest.features.includes("renderer:fog"));
    assert.ok(result.manifest.features.includes("environment:hdr"));
    assert.ok(result.manifest.features.includes("background:skybox"));
    assert.match(result.cpp, /bbl::load_hdr_environment\(/);
    assert.match(
        result.cpp,
        /bbl::set_scene_fog\(v_scene, 3\.0f, 0\.0f, 50\.0f, 800\.0f, bbl::Color3\{0\.1f, 0\.2f, 0\.3f\}\)/,
    );
});

test("writes lighting-only environment rotation into native scene state", () => {
    const result = compileSource(
        `
        import {
            createEngine,
            createSceneContext,
            loadEnvironment,
            setEnvironmentRotation,
        } from "babylon-lite";

        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            await loadEnvironment(scene, "/studio.env", {
                skipSkybox: true,
                skipGround: true,
                brdfUrl: "/brdf-lut.png",
            });
            setEnvironmentRotation(scene, 1.9);
        }
    `,
        labDeployment,
    );

    assert.ok(result.manifest.features.includes("environment:ibl"));
    assert.match(result.cpp, /v_scene\.environment\.rotation_y = 1\.9f;/);
});

test("accepts the DDS loader's inert skybox and ground skip flags", () => {
    const result = compileSource(
        `
        import {
            createEngine,
            createSceneContext,
            loadDdsEnvironment,
        } from "babylon-lite";

        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            await loadDdsEnvironment(scene, "/studio.dds", {
                brdfUrl: "/brdf-lut.png",
                skipSkybox: true,
                skipGround: true,
            });
        }
    `,
        labDeployment,
    );

    assert.ok(result.manifest.features.includes("environment:ibl"));
    assert.ok(result.manifest.features.includes("environment:dds"));
    assert.deepEqual(
        result.manifest.assets.map(({ source, kind }) => ({ source, kind })),
        [
            {
                source: pinnedAssetUrl("lab/public/studio.dds"),
                kind: "dds-environment",
            },
            {
                source: pinnedAssetUrl(
                    "packages/babylon-lite/assets/brdf-lut.png",
                ),
                kind: "texture",
            },
        ],
    );
    assert.match(result.cpp, /bbl::load_dds_environment\(/);
    assert.doesNotMatch(result.cpp, /skipSkybox|skipGround/);
});

test("does not activate IBL from environment rotation alone", () => {
    const result = compileSource(`
        import {
            createEngine,
            createSceneContext,
            setEnvironmentRotation,
        } from "babylon-lite";

        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            setEnvironmentRotation(scene, 1.9);
        }
    `);

    assert.ok(!result.manifest.features.includes("environment:ibl"));
    assert.match(result.cpp, /v_scene\.environment\.rotation_y = 1\.9f;/);
});

test("rejects rotating a visible environment skybox in either call order", () => {
    const prelude = `
        import {
            createEngine,
            createSceneContext,
            loadEnvironment,
            setEnvironmentRotation,
        } from "babylon-lite";

        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
    `;
    const visibleSkybox = `
        await loadEnvironment(scene, "/studio.env", {
            skyboxUrl: "/studio.env",
            skipGround: true,
        });
    `;

    assert.throws(
        () =>
            compileSource(
                `${prelude}${visibleSkybox}
                    setEnvironmentRotation(scene, 1.9);
                }`,
                labDeployment,
            ),
        /rotating one requires native skybox rotation support/,
    );
    assert.throws(
        () =>
            compileSource(
                `${prelude}
                    setEnvironmentRotation(scene, 1.9);
                    ${visibleSkybox}
                }`,
                labDeployment,
            ),
        /Loading a visible environment skybox after setEnvironmentRotation requires native skybox rotation support/,
    );
});

test("tracks environment rotation boundaries through scene parameters", () => {
    assert.throws(
        () =>
            compileSource(
                `
                import {
                    createEngine,
                    createSceneContext,
                    loadEnvironment,
                    setEnvironmentRotation,
                } from "babylon-lite";
                import type { SceneContext } from "babylon-lite";

                async function addSkybox(scene: SceneContext) {
                    await loadEnvironment(scene, "/studio.env", {
                        skyboxUrl: "/studio.env",
                        skipGround: true,
                    });
                }

                async function main() {
                    const engine = await createEngine({});
                    const scene = createSceneContext(engine);
                    await addSkybox(scene);
                    setEnvironmentRotation(scene, 1.9);
                }
            `,
                labDeployment,
            ),
        /rotating one requires native skybox rotation support/,
    );
    assert.throws(
        () =>
            compileSource(
                `
                import {
                    createEngine,
                    createSceneContext,
                    loadEnvironment,
                    setEnvironmentRotation,
                } from "babylon-lite";
                import type { SceneContext } from "babylon-lite";

                function rotate(scene: SceneContext) {
                    setEnvironmentRotation(scene, 1.9);
                }

                async function main() {
                    const engine = await createEngine({});
                    const scene = createSceneContext(engine);
                    rotate(scene);
                    await loadEnvironment(scene, "/studio.env", {
                        skyboxUrl: "/studio.env",
                        skipGround: true,
                    });
                }
            `,
                labDeployment,
            ),
        /Loading a visible environment skybox after setEnvironmentRotation requires native skybox rotation support/,
    );
});

test("rejects setFog with a runtime fog mode", () => {
    assert.throws(
        () =>
            compileSource(
                `import { createEngine, createSceneContext, setFog, registerScene, startEngine } from "babylon-lite";
async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    setFog(scene, { mode: 5 as 0 | 1 | 2 | 3, density: 0.1, start: 0, end: 10, color: [1, 1, 1] });
    await registerScene(scene);
    await startEngine(engine);
}
void main();
`,
                {
                    fileName:
                        "corpus/babylon-lite/lab/lite/src/lite/fog-mode.ts",
                },
            ),
        /setFog mode must be a static 0 \(none\), 1 \(exp\), 2 \(exp2\), or 3 \(linear\) literal/,
    );
});

// ---------------------------------------------------------------------------
// The line-system family
// ---------------------------------------------------------------------------

const LINE_SCENE = (body: string, imports = ""): string => `
    import { addToScene, createArcRotateCamera, createEngine, createLineSystem, createSceneContext, registerScene, startEngine${imports} } from "babylon-lite";

    async function main(): Promise<void> {
        const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
        const engine = await createEngine(canvas);
        const scene = createSceneContext(engine);
${body}
        scene.camera = createArcRotateCamera(0, 1, 12, { x: 0, y: 0, z: 0 });
        await registerScene(scene);
        await startEngine(engine);
    }
`;

const UNIFORM_LINE_SYSTEM = `        addToScene(
            scene,
            createLineSystem(engine, {
                name: "lines",
                lines: [[{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }, { x: 2, y: 0, z: 0 }]],
                color: { r: 0.25, g: 0.85, b: 1, a: 1 },
                useVertexAlpha: false,
            }),
        );`;

test("composes the pin's own line material for the permutation a scene reaches", () => {
    const result = compileSource(LINE_SCENE(UNIFORM_LINE_SYSTEM));
    const [program] = result.manifest.customShaderPrograms;
    // The variant's identity is the permutation: the pin names every line
    // material "LineMaterial" while composing a different program per flag
    // set, so a scene reaching two forms registers two variants.
    assert.equal(program?.name, "line-material-opaque");
    assert.equal(program?.topology, "line-list");
    // The two system matrices the pin's own stage reads, plus the uniform a
    // stage with no colour varying declares instead.
    assert.deepEqual(program?.uniforms, [
        "world",
        "viewProjection",
        "lineColor:vec4<f32>",
    ]);
    assert.deepEqual(program?.attributes, ["position"]);
    assert.deepEqual(program?.uniformDefaults, [
        { name: "lineColor", values: [0.25, 0.85, 1, 1] },
    ]);
    // useVertexAlpha false: no blend, so the pin's own depthWrite default
    // resolves the other way.
    assert.equal(program?.needAlphaBlending, false);
    assert.equal(program?.depthWrite, true);
    assert.equal(program?.backFaceCulling, false);
    assert.match(
        program?.vertexSource ?? "",
        /out\.position=shaderSystem\.viewProjection\*finalWorld\*vec4<f32>\(input\.position,1\.0\)/,
    );
    assert.match(
        program?.fragmentSource ?? "",
        /return shaderUniforms\.lineColor;/,
    );
    assert.ok(result.manifest.features.includes("mesh:lines"));
});

test("infers a line system's vertex-colour fork from its geometry", () => {
    const result = compileSource(
        LINE_SCENE(`        addToScene(
            scene,
            createLineSystem(engine, {
                lines: [[{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }]],
                colors: [[{ r: 1, g: 0, b: 0, a: 1 }, { r: 0, g: 1, b: 0, a: 0.5 }]],
            }),
        );`),
    );
    const [program] = result.manifest.customShaderPrograms;
    assert.equal(program?.name, "line-material-vc");
    assert.deepEqual(program?.attributes, ["position", "color"]);
    // A stage carrying the colour varying declares no uniform at all.
    assert.deepEqual(program?.uniforms, ["world", "viewProjection"]);
    assert.equal(program?.needAlphaBlending, true);
    assert.equal(program?.depthWrite, false);
    assert.match(program?.fragmentSource ?? "", /return input\.color;/);
});

test("reads the thin-instance lanes the pin's own module appends", () => {
    const result = compileSource(
        LINE_SCENE(
            `        const material = createLineMaterial({
            useThinInstances: true,
            useThinInstanceColors: true,
        });
        const mesh = createLineSystem(engine, {
            lines: [[{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }]],
            material,
        });
        setThinInstances(mesh, new Float32Array(32), 2);
        setThinInstanceColors(mesh, new Float32Array(8));
        addToScene(scene, mesh);`,
            ", createLineMaterial, setThinInstanceColors, setThinInstances",
        ),
    );
    const [program] = result.manifest.customShaderPrograms;
    assert.equal(program?.name, "line-material-ti-tic");
    assert.equal(program?.useThinInstanceColors, true);
    assert.match(
        program?.vertexSource ?? "",
        /let instanceWorld=mat4x4<f32>\(input\.world0,input\.world1,input\.world2,input\.world3\)/,
    );
    assert.match(
        program?.vertexSource ?? "",
        /out\.color=input\.instanceColor;/,
    );
    assert.ok(result.manifest.features.includes("mesh:thin-instance-colors"));
    // The pool keeps referencing the caller's array, so a temporary is
    // bound to a name whose lifetime is the frame loop.
    assert.match(
        result.cpp,
        /std::variant<bbl::js::F32Array, bbl::js::F64Array> v_bblite_thin_instances_\d+ = /,
    );
});

test("refuses the line shapes outside the reached slice", () => {
    // The pin throws when a supplied material's vertex-colour setting and
    // the geometry's colour buffer disagree; the compiler knows both.
    assert.throws(
        () =>
            compileSource(
                LINE_SCENE(
                    `        const material = createLineMaterial({ useVertexColor: true });
        addToScene(
            scene,
            createLineSystem(engine, {
                lines: [[{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }]],
                material,
            }),
        );`,
                    ", createLineMaterial",
                ),
            ),
        /material\.useVertexColor to match the line color-buffer layout/,
    );
    // Instance colours without instances is the pin's own refusal.
    assert.throws(
        () =>
            compileSource(
                LINE_SCENE(
                    `        const material = createLineMaterial({ useThinInstanceColors: true });
        addToScene(scene, createLineSystem(engine, { lines: [[{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }]], material }));`,
                    ", createLineMaterial",
                ),
            ),
        /requires useThinInstances when useThinInstanceColors is enabled/,
    );
    // A shader material the line factory did not build: it carries a
    // variant like a line material and composes no line-list program.
    assert.throws(
        () =>
            compileSource(
                LINE_SCENE(
                    `        const material = createShaderMaterial({
            name: "plain",
            vertexSource: "struct VertexOutput{@builtin(position) position:vec4<f32>,};@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;out.position=shaderSystem.worldViewProjection*vec4<f32>(input.position,1.0);return out;}",
            fragmentSource: "@fragment fn mainFragment()->@location(0) vec4<f32>{return vec4<f32>(1.0,1.0,1.0,1.0);}",
            attributes: ["position"],
            uniforms: ["worldViewProjection"],
        });
        addToScene(scene, createLineSystem(engine, { lines: [[{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }]], material }));`,
                    ", createShaderMaterial",
                ),
            ),
        /line system's material comes from createLineMaterial/,
    );
    // One colour row per line, one colour per point: both are the pin's own
    // validation, refused at generation where it throws at load.
    assert.throws(
        () =>
            compileSource(
                LINE_SCENE(`        addToScene(
            scene,
            createLineSystem(engine, {
                lines: [[{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }]],
                colors: [[{ r: 1, g: 0, b: 0, a: 1 }]],
            }),
        );`),
            ),
        /one color per point/,
    );
});

const rebuildAfterStart = (register: string): string => `
    import {
        createEngine,
        createPbrMaterial,
        createSceneContext,
        rebuildMaterial,
        registerScene,
        startEngine,
    } from "@babylonjs/lite";
    async function main() {
        const engine = await createEngine({});
        const scene = createSceneContext(engine);
        const material = createPbrMaterial({});
        ${register}
        await startEngine(engine);
        rebuildMaterial(scene, material);
    }
    void main();
`;

test("rebuildMaterial after startEngine rebuilds a registered scene's rows", () => {
    const result = compileSource(
        rebuildAfterStart("await registerScene(scene);"),
    );
    assert.ok(result.cpp.includes("bbl::rebuild_material("));
    assert.ok(result.manifest.features.includes("material:runtime-rebuild"));
});

test("refuses rebuildMaterial after startup for a scene the program never registers", () => {
    assert.throws(
        () => compileSource(rebuildAfterStart("")),
        /rebuilds a registered scene's renderables; this program registers none/,
    );
});

/**
 * The PBR lightmap's compile-time half.
 *
 * Every option the setter takes except the level is composition input —
 * `lightmap-fragment.ts`'s own `detect` reads the blend, the UV set, the
 * gamma decode and the texture's `invertY`/`uAng` pair — so what these
 * assert is that each one settles at generation and that the shapes which
 * cannot settle refuse by name rather than composing a plausible arm.
 */
const lightmapScene = (body: string): string => `
    import {
        createEngine,
        createPbrMaterial,
        enablePbrLightmap,
        loadTexture2D,
        setPbrLightmap,
    } from "@babylonjs/lite";

    async function main() {
        const engine = await createEngine({});
        ${body}
    }
`;

test("stamps a scene-code PBR lightmap with the arms composition reads", () => {
    const result = compileSource(
        lightmapScene(`
        await enablePbrLightmap();
        const lightmap = await loadTexture2D(engine, "/textures/lm.png");
        lightmap.uAng = Math.PI;
        const material = createPbrMaterial({});
        setPbrLightmap(material, lightmap, {
            coordIndex: 0,
            level: 0.8,
            gamma: true,
        });
    `),
        labDeployment,
    );

    assert.ok(result.manifest.features.includes("material:lightmap"));
    assert.deepEqual(result.manifest.scenePbrMaterials[0]?.lightmap, {
        coordIndex: 0,
        useAsShadowmap: false,
        gamma: true,
        // `loadTexture2D` never sets the texture-OBJECT invertY, so the
        // pin's own V-flip test is decided by the `uAng` write alone.
        textureInvertY: false,
        textureUAng: Math.PI,
    });
    // The one runtime lane: `writeLightmapUBO` reads the level live.
    assert.match(result.cpp, /bbl::set_pbr_lightmap\([^\n]*, 0\.8f\)/);
    assert.match(result.cpp, /\.data\.uv_transform\.u_ang = 3\.14159/);
});

test("defaults a lightmap to the pin's own TEXCOORD_1 and additive blend", () => {
    const result = compileSource(
        lightmapScene(`
        await enablePbrLightmap();
        const lightmap = await loadTexture2D(engine, "/textures/lm.png");
        const material = createPbrMaterial({});
        setPbrLightmap(material, lightmap);
    `),
        labDeployment,
    );

    assert.deepEqual(result.manifest.scenePbrMaterials[0]?.lightmap, {
        coordIndex: 1,
        useAsShadowmap: false,
        gamma: false,
        textureInvertY: false,
        textureUAng: 0,
    });
    assert.match(result.cpp, /bbl::set_pbr_lightmap\([^\n]*, 1\.0f\)/);
});

test("refuses setPbrLightmap before the opt-in registers the extension", () => {
    assert.throws(
        () =>
            compileSource(
                lightmapScene(`
                const lightmap = await loadTexture2D(engine, "/t/lm.png");
                const material = createPbrMaterial({});
                setPbrLightmap(material, lightmap, { coordIndex: 0 });
            `),
                labDeployment,
            ),
        /reached before `enablePbrLightmap\(\)`/,
    );
});

test("refuses a lightmap blend generation cannot settle", () => {
    assert.throws(
        () =>
            compileSource(
                `
                import {
                    createEngine,
                    createPbrMaterial,
                    createSceneContext,
                    enablePbrLightmap,
                    loadTexture2D,
                    setPbrLightmap,
                } from "@babylonjs/lite";

                async function main() {
                    const engine = await createEngine({});
                    const scene = createSceneContext(engine);
                    await enablePbrLightmap();
                    const lightmap = await loadTexture2D(engine, "/t/lm.png");
                    const material = createPbrMaterial({});
                    for (const mesh of scene.meshes) {
                        setPbrLightmap(material, lightmap, {
                            useAsShadowmap: mesh.name === "level",
                        });
                    }
                }
            `,
                labDeployment,
            ),
        // The static evaluator refuses the non-literal read first, which is
        // the same answer one rung earlier: the blend decides which of the
        // pinned fragment's arms composes, so it cannot be per draw.
        /Expected a boolean literal/,
    );
});

test("refuses a lightmap UV set the pinned extension does not declare", () => {
    assert.throws(
        () =>
            compileSource(
                lightmapScene(`
                await enablePbrLightmap();
                const lightmap = await loadTexture2D(engine, "/t/lm.png");
                const material = createPbrMaterial({});
                setPbrLightmap(material, lightmap, { coordIndex: 2 });
            `),
                labDeployment,
            ),
        /TEXCOORD_0 or TEXCOORD_1/,
    );
});

test("folds a loaded container's lightmap walk to its mesh-name filter", () => {
    const result = compileSource(
        `
        import {
            addToScene,
            createEngine,
            createSceneContext,
            enablePbrLightmap,
            loadGltf,
            loadTexture2D,
            setPbrLightmap,
            type PbrMaterialProps,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            await enablePbrLightmap();
            const lightmap = await loadTexture2D(engine, "/textures/lm.png");
            lightmap.uAng = Math.PI;
            const container = await loadGltf(engine, "/models/level.glb");
            addToScene(scene, container);
            for (const mesh of scene.meshes) {
                if (mesh.name !== "level" && !mesh.name.startsWith("level_")) {
                    continue;
                }
                const mat = mesh.material as PbrMaterialProps | undefined;
                if (mat) {
                    setPbrLightmap(mat, lightmap, { level: 3.2, gamma: true });
                }
            }
        }
    `,
        labDeployment,
    );

    const asset = result.manifest.assets.find((entry) => entry.kind === "gltf");
    // The filter travels as the predicate the loop wrote, negated: the body
    // runs for exactly the names the `continue` does not skip. The document
    // is what evaluates it, at composition.
    assert.deepEqual(asset?.sceneLightmap?.meshNamePredicate, {
        kind: "not",
        operand: {
            kind: "and",
            operands: [
                { kind: "not", operand: { kind: "equals", value: "level" } },
                {
                    kind: "not",
                    operand: { kind: "startsWith", value: "level_" },
                },
            ],
        },
    });
    assert.equal(asset?.sceneLightmap?.options.coordIndex, 1);
    assert.equal(asset?.sceneLightmap?.options.gamma, true);
    assert.equal(asset?.sceneLightmap?.options.textureUAng, Math.PI);
    assert.match(result.cpp, /bbl::set_pbr_lightmap\([^\n]*, 3\.2f\)/);
});

test("refuses a lightmap walk filter outside the folded grammar", () => {
    assert.throws(
        () =>
            compileSource(
                `
                import {
                    addToScene,
                    createEngine,
                    createSceneContext,
                    enablePbrLightmap,
                    loadGltf,
                    loadTexture2D,
                    setPbrLightmap,
                    type PbrMaterialProps,
                } from "@babylonjs/lite";

                async function main() {
                    const engine = await createEngine({});
                    const scene = createSceneContext(engine);
                    await enablePbrLightmap();
                    const lightmap = await loadTexture2D(engine, "/t/lm.png");
                    const container = await loadGltf(engine, "/m/level.glb");
                    addToScene(scene, container);
                    for (const mesh of scene.meshes) {
                        if (mesh.name.length > 4) {
                            continue;
                        }
                        const mat = mesh.material as PbrMaterialProps | undefined;
                        if (mat) {
                            setPbrLightmap(mat, lightmap, { coordIndex: 0 });
                        }
                    }
                }
            `,
                labDeployment,
            ),
        /closed grammar/,
    );
});

test("binds a colour helper's returned tuple instead of splicing the call", () => {
    // Each Color3 sink evaluates its tuple-producing call once.
    const sourcePath = "corpus/babylon-lite/lab/lite/src/lite/scene44.ts";
    const result = compileSource(readFileSync(resolve(sourcePath), "utf8"), {
        fileName: sourcePath,
    });
    const bindings = [
        ...result.cpp.matchAll(
            /const bbl::js::Tuple<3> (\w+) = bbl::js::snapshot_value\(bblscene::colorFor\(/g,
        ),
    ];
    assert.equal(bindings.length, 4);
    for (const [, name] of bindings) {
        assert.equal(result.cpp.split(`${name}[`).length - 1, 3);
    }
    assert.doesNotMatch(
        result.cpp,
        /bbl::Color3\{static_cast<float>\(bblscene::colorFor/,
    );
});

test("folds an emissive colour arriving through a user-function parameter", () => {
    // The same widening, at a VALUE sink rather than a refusal one:
    // `setPbrEmissive` omits the field instead of failing when the fold
    // misses, so before this the colour silently defaulted to black in the
    // composed variant. Tested separately because that difference is what
    // makes the whole-tree neutrality proof load-bearing for this sink and
    // a formality for the unlit one.
    const result = compileSource(`
        import {
            createEngine,
            createPbrMaterial,
            setPbrEmissive,
        } from "@babylonjs/lite";

        type ColorTuple = [number, number, number];

        function glow(color: ColorTuple) {
            const material = createPbrMaterial({});
            setPbrEmissive(material, color);
            return material;
        }

        async function main() {
            await createEngine({});
            glow([0.125, 0.25, 0.5]);
        }
    `);

    assert.match(
        result.cpp,
        /set_pbr_emissive\(.*bbl::Color3\{0\.125f, 0\.25f, 0\.5f\}\)/,
    );
});

test("folds a setter's tint arriving through a user-function parameter", () => {
    // `requiredStaticColor3` needs the channels at generation because they
    // enter the composed PBR variant, and syntactic resolution stops at a
    // parameter binding. The emitted half already reads that binding out
    // of the value model; this is the folded half reading the same tuple,
    // through two nested inlined frames.
    const result = compileSource(`
        import {
            createEngine,
            createPbrMaterial,
            createSolidTexture2D,
            setPbrUnlit,
        } from "@babylonjs/lite";
        import type { EngineContext } from "@babylonjs/lite";

        type ColorTuple = [number, number, number];

        function unlit(engine: EngineContext, color: ColorTuple) {
            const material = createPbrMaterial({
                baseColorTexture: createSolidTexture2D(engine, color[0], color[1], color[2]),
            });
            setPbrUnlit(material, color);
            return material;
        }

        function outer(engine: EngineContext, color: ColorTuple) {
            return unlit(engine, color);
        }

        async function main() {
            const engine = await createEngine({});
            outer(engine, [0.25, 0.5, 0.75]);
        }
    `);

    assert.match(
        result.cpp,
        /set_pbr_unlit\(.*bbl::Color3\{0\.25f, 0\.5f, 0\.75f\}\)/,
    );
});

test("refuses a setter tint whose channels are not generation-known", () => {
    // The value model answers a runtime tuple too, and its lanes have no
    // static number: the channels the composed variant needs are genuinely
    // absent, so the fold must still refuse rather than read zeroes.
    assert.throws(
        () =>
            compileSource(`
                import {
                    createEngine,
                    createPbrMaterial,
                    createSolidTexture2D,
                    setPbrUnlit,
                } from "@babylonjs/lite";
                import type { EngineContext } from "@babylonjs/lite";

                type ColorTuple = [number, number, number];

                function unlit(engine: EngineContext, color: ColorTuple) {
                    const material = createPbrMaterial({
                        baseColorTexture: createSolidTexture2D(engine, 1, 1, 1),
                    });
                    setPbrUnlit(material, color);
                    return material;
                }

                async function main() {
                    const engine = await createEngine({});
                    const tint: ColorTuple = [Math.random(), 0.5, 0.75];
                    unlit(engine, tint);
                }
            `),
        /setPbrUnlit's tint must be a static linear RGB colour/,
    );
});
