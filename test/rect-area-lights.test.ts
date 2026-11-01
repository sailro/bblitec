import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import {
    pinnedErrorCodeOf,
    pinnedErrorMessage,
} from "../src/lowering/pinned-error.js";
import {
    areaLightLtcSources,
    rectAreaEmissionRefusalMessage,
    rectAreaLightDefaultIntensity,
    rectAreaNodeLightingRefusalMessage,
    RectAreaLightLowerer,
} from "../src/lowering/rect-area-light-lowerer.js";
import { pinnedMatrixHeader } from "../src/lowering/pinned-matrix.js";
import { pinnedWorldTransformHeader } from "../src/lowering/pinned-world-transform.js";
import {
    lightUniformsBlock,
    pinnedStandardVariantsHeader,
} from "../src/pinned-pbr-variant-cpp.js";
import {
    areaLightImageSource,
    type AreaLightImageRequest,
    decodeAreaLightLtcTables,
    pinnedAreaLightBindingPairs,
    pinnedAreaLightEmissionBindings,
    pinnedAreaLightImageShape,
    pinnedAreaLightLtcShape,
    pinnedAreaLightLtcUrl,
    pinnedRectAreaEmissionPbr,
    pinnedRectAreaEmissionStandard,
    pinnedRectAreaPbr,
    pinnedRectAreaStandard,
    reachedRectAreaLightings,
    rectAreaLayeredRefusal,
    rectAreaLightingModes,
} from "../src/pinned-rect-area-lights.js";
import { lightParameterHeader } from "../src/lowering/light-parameters.js";
import {
    LightLowerer,
    lowerLightHierarchy,
} from "../src/lowering/light-lowerer.js";
import { pinnedMaxLights } from "../src/lowering/pinned-max-lights.js";
import { demotableUniformBlocks } from "../src/shader-bindings.js";
import { pinnedSceneArms } from "../src/pinned-scene-arms.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import {
    composePinnedStandardVariant,
    pinnedStandardSupportBlock,
    pinnedStandardVariantManifestEntry,
    standardExtensionWriters,
} from "../src/pinned-standard-variants.js";
import { pinnedError } from "./pinned-errors.js";
import { inlineCpp } from "./generated-cpp.js";
import { regexText } from "./regex.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

interface PinRectAreaLight {
    intensity: number;
    diffuse: [number, number, number];
    specular: [number, number, number];
    parent: unknown;
    rotationQuaternion: {
        set(x: number, y: number, z: number, w: number): void;
    };
    _writeLightUbo(data: Float32Array, offset: number): void;
}

interface PinTransformNode {
    rotationQuaternion: {
        set(x: number, y: number, z: number, w: number): void;
    };
    scaling: { set(x: number, y: number, z: number): void };
    worldMatrix: Float32Array;
}

const pinRectAreaLight = (): Promise<{
    createRectAreaLight(
        position: [number, number, number],
        width: number,
        height: number,
        intensity?: number,
    ): PinRectAreaLight;
}> => importPinnedModule("light/rect-area-light.js");

test("the rect area light writer matches the pinned _writeLightUbo bit for bit", async (t) => {
    // A parented, rotated, nonuniformly scaled emitter: the writer packs
    // the world centre and both scaled half axes, unnormalized. Every input
    // is a dyadic rational, so the native float lanes hold it exactly.
    const { createTransformNode } = await importPinnedModule<{
        createTransformNode: (
            name: string,
            x: number,
            y: number,
            z: number,
        ) => PinTransformNode;
    }>("scene/transform-node.js");
    const parent = createTransformNode("parent", 0.5, 4, 5);
    parent.rotationQuaternion.set(0.125, 0.5, 0.25, 0.8125);
    parent.scaling.set(1.5, 0.75, 1.25);
    const light = (await pinRectAreaLight()).createRectAreaLight(
        [0.25, -1, 2],
        2.5,
        2,
        3,
    );
    light.parent = parent;
    light.rotationQuaternion.set(0, 0.375, 0, 0.875);
    light.diffuse = [1, 0.5, 0.25];
    light.specular = [0.75, 1, 0.125];
    const data = new Float32Array(16);
    light._writeLightUbo(data, 0);
    const expected = [...new Uint32Array(data.buffer)];
    const parentWorld = [...parent.worldMatrix].map(Math.fround);

    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    const directory = resolve("artifacts/rect-area-light-writer");
    const headers = resolve(directory, "bblite/upstream");
    mkdirSync(headers, { recursive: true });
    const context = new LoweringContext();
    writeFileSync(
        resolve(headers, "pinned_world_transform.hpp"),
        pinnedWorldTransformHeader(context),
    );
    writeFileSync(
        resolve(headers, "pinned_matrix.hpp"),
        pinnedMatrixHeader(context),
    );
    const float = (value: number): string => `${value.toPrecision(9)}f`;
    runGeneratedProgram(
        tools,
        "rect-area-light-writer",
        `
#include <bblite/upstream/pinned_world_transform.hpp>
#include <bit>
#include <cassert>
namespace bbl::upstream { ${lightUniformsBlock(context, 16, ["rectArea"])} }
int main(){
 bbl::LightRecord light;
 light.kind=bbl::LightKind::rect_area;
 light.position=bbl::Vec3{0.25f,-1.0f,2.0f};
 light.width=2.5;light.height=2;light.intensity=3;
 light.diffuse_color={1.0,0.5,0.25};
 light.specular_color={0.75f,1.0f,0.125f};
 light.rotation_quaternion=bbl::Vec4{0.0f,0.375f,0.0f,0.875f};
 light.has_rotation_quaternion=true;
 light.parent_world_matrix=[]{return std::array<float,16>{${parentWorld.map(float).join(",")}};};
 bbl::upstream::LightEntry out;bbl::upstream::write_pinned_light(light,out);
 const std::array<const std::array<float,4>*,4> rows{&out.vLightData,&out.vLightDiffuse,&out.vLightSpecular,&out.vLightDirection};
 const std::array<std::uint32_t,16> expected{${expected.map((bits) => `${bits}u`).join(",")}};
 for(std::size_t lane=0;lane<16;++lane) assert(std::bit_cast<std::uint32_t>((*rows[lane/4])[lane%4])==expected[lane]);
}
`,
        { flags: [`/I${directory}`], timeoutMs: 10000, expectedOutput: "" },
    );
});

test("the rect area factory, setters and scene validation carry the pin's contracts", async () => {
    const context = new LoweringContext();
    const source = new RectAreaLightLowerer(context).lower().source;
    // The pin's `intensity = 1` default and its white colour pair.
    const pin = (await pinRectAreaLight()).createRectAreaLight([0, 0, 0], 1, 1);
    assert.equal(rectAreaLightDefaultIntensity(context), pin.intensity);
    assert.deepEqual([...pin.diffuse], [1, 1, 1]);
    assert.match(
        source,
        /light\.diffuse_color = Color3\{1\.0f, 1\.0f, 1\.0f\};/,
    );
    assert.match(source, /light\.kind = LightKind::rect_area;/);
    // validateSize, before the record exists and in every accessor.
    for (const field of ["width", "height", "intensity"])
        assert.match(
            source,
            new RegExp(`validate_rect_area_size\\(${field}, "${field}"\\);`),
        );
    for (const field of ["width", "height", "intensity"])
        assert.match(
            source,
            new RegExp(
                `set_rect_area_light_${field}[\\s\\S]*?validate_rect_area_size\\(value, "${field}"\\);[\\s\\S]*?if \\(record\\.${field} != value\\)`,
            ),
        );
    // Every refusal is the pin's own decoded message.
    for (const message of [
        "RectAreaLight: cannot enable lighting on a disposed scene",
        "RectAreaLight: area-light shadows are not supported yet",
        "RectAreaLight: await enableRectAreaLights(scene) before registering this scene",
    ]) {
        assert.ok(pinnedError(message).startsWith("#"));
        assert.ok(
            source.includes(
                JSON.stringify(
                    pinnedErrorMessage(
                        context,
                        pinnedErrorCodeOf(context, message),
                    ),
                ),
            ),
            message,
        );
    }
    assert.ok(
        pinnedError(
            "RectAreaLight: ${a0} must be finite and nonnegative, got ${a1}",
        ).startsWith("#"),
    );
    assert.match(
        source,
        /"RectAreaLight: "\) \+ std::string\(name\) \+ " must be finite and nonnegative, got " \+ js::number_to_string\(value\)/,
    );
    // A Node graph reading the lights block refuses in an area scene.
    const node =
        "RectAreaLight: NodeMaterial lighting blocks are not supported yet; use PBR or Standard materials, or an unlit node graph";
    assert.ok(pinnedError(node).startsWith("#"));
    assert.equal(rectAreaNodeLightingRefusalMessage(context), node);
    // The layered-BRDF refusal a selected area light raises is the pin's.
    const layered = rectAreaLayeredRefusal();
    assert.equal(`#${layered.code}`, pinnedError(layered.message));
});

test("scene code reaches the rect area factory, hierarchy and opt-in", () => {
    const result = compileSource(`
import { addToScene, createBox, createEngine, createRectAreaLight, createSceneContext, createTransformNode, enableRectAreaLights, registerScene, startEngine } from "@babylonjs/lite";
const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const engine = await createEngine(canvas);
const scene = createSceneContext(engine);
const node = createTransformNode("parent", 0, 4, 5);
addToScene(scene, node);
const light = createRectAreaLight([0, 0, 0], 2.5, 2);
light.name = "front";
light.parent = node;
light.rotationQuaternion.set(0, 0.1, 0, 0.99);
light.diffuse = [1, 0, 1];
light.width = 3;
addToScene(scene, light);
const panel = createBox(engine, { width: 2.5, height: 2, depth: 0.01 });
panel.parent = light;
addToScene(scene, panel);
await enableRectAreaLights(scene);
await registerScene(scene);
await startEngine(engine);
`);
    for (const feature of [
        "light:rect-area",
        "light:rect-area-lighting",
        "light:hierarchy",
        "mesh:parenting",
    ])
        assert.ok(result.manifest.features.includes(feature), feature);
    assert.ok(!result.manifest.features.includes("mesh:world-matrix-provider"));
    assert.match(
        result.cpp,
        /bbl::create_rect_area_light\([^;]*, 2\.5, 2\.0, 1\.0\)/,
    );
    // A light's name is a field nothing native reads: evaluated, not stored.
    assert.doesNotMatch(result.cpp, /\.name = "front";/);
    assert.match(
        result.cpp,
        /bbl::set_light_parent\([^;]*bbl::SceneNodeHandle\{/,
    );
    assert.match(result.cpp, /bbl::set_light_rotation_quaternion\(/);
    assert.match(
        result.cpp,
        /\.diffuse_color = bbl::Color3\{1\.0f, 0\.0f, 1\.0f\};/,
    );
    assert.match(result.cpp, /bbl::set_rect_area_light_width\([^;]*, 3\.0\);/);
    assert.match(result.cpp, /bbl::set_mesh_light_parent\(/);
    // The LTC tables are the opt-in's own assets.
    const [ltc1, ltc2] = areaLightLtcSources.map(
        (source) =>
            result.manifest.assets.find((asset) => asset.source === source)
                ?.output,
    );
    assert.ok(ltc1 && ltc2);
    assert.match(
        result.cpp,
        new RegExp(
            `bbl::enable_rect_area_lights\\([^;]*bbl::asset_path\\("${ltc1}"\\), bbl::asset_path\\("${ltc2}"\\)\\)`,
        ),
    );
});

test("a rectangle's size and intensity take compound writes through their accessors", () => {
    const result = compileSource(`
import { createEngine, createRectAreaLight } from "@babylonjs/lite";
const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const engine = await createEngine(canvas);
const light = createRectAreaLight([0, 0, 0], 1, 1);
light.width += 2;
light.height *= 3;
light.intensity -= 0.5;
`);
    for (const [field, operator] of [
        ["width", "\\+"],
        ["height", "\\*"],
        ["intensity", "-"],
    ] as const)
        assert.match(
            result.cpp,
            new RegExp(
                `bbl::set_rect_area_light_${field}\\([^;]*\\.${field} ${operator} `,
            ),
        );
});

test("setLightIntensity on a rectangular light stores through its validating accessor", () => {
    const result = compileSource(`
import { createEngine, createRectAreaLight, setLightIntensity } from "@babylonjs/lite";
const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const engine = await createEngine(canvas);
const light = createRectAreaLight([0, 0, 0], 1, 1);
setLightIntensity(light, 2);
`);
    // The scene calls the pin's setter as for any light; its
    // `light.intensity = intensity` store is the kind's validating accessor.
    assert.match(result.cpp, /bbl::set_light_intensity\([^;]*,2\.0\)/);
    assert.doesNotMatch(result.cpp, /set_rect_area_light_intensity/);
    const header = lightParameterHeader(new LoweringContext(), ["rectArea"]);
    assert.match(
        header,
        /if \(light\.kind == LightKind::rect_area\) set_rect_area_light_intensity\(light, intensity\); else light\.intensity=intensity;/,
    );
    assert.doesNotMatch(
        lightParameterHeader(new LoweringContext(), ["point"]),
        /set_rect_area_light_intensity/,
    );
});

test("an unprocessed emission texture refuses natively by the pin's own messages", () => {
    const message =
        "RectAreaLight: preprocess emissionTexture with processAreaLightTexture(engine, source) before enabling";
    const processed =
        "RectAreaLight: emissionTexture must be returned by processAreaLightTexture(engine, source)";
    assert.ok(pinnedError(message).startsWith("#"));
    assert.ok(pinnedError(processed).startsWith("#"));
    assert.equal(
        rectAreaEmissionRefusalMessage(new LoweringContext(), false),
        message,
    );
    assert.equal(
        rectAreaEmissionRefusalMessage(new LoweringContext(), true),
        processed,
    );
    // The accessor takes any texture, as the pin's does; an unprocessed one
    // is marked, and the scene that packs it refuses.
    const result = compileSource(`
import { createEngine, createRectAreaLight, loadTexture2D } from "@babylonjs/lite";
const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const engine = await createEngine(canvas);
const light = createRectAreaLight([0, 0, 0], 1, 1);
light.emissionTexture = await loadTexture2D(engine, "https://example.com/emitter.png");
`);
    assert.match(
        result.cpp,
        /bbl::set_rect_area_light_emission\([^;]*bbl::unprocessed_area_light_image\(\)\)\);/,
    );
    // Without processAreaLightTexture no seam is installed, so
    // enableRectAreaLights refuses the packed texture; with one, the
    // snapshot's validateAreaLightImage refuses the unprocessed image.
    const context = new LoweringContext();
    const solid = new RectAreaLightLowerer(context).lower().source;
    const textured = new RectAreaLightLowerer(context, true).lower().source;
    for (const source of [solid, textured])
        assert.match(
            source,
            new RegExp(
                `if \\(!scene\\.engine->area_light_emission_installed\\) \\{[\\s\\S]*?light\\.emission_texture\\) \\{\\s*throw std::runtime_error\\(${regexText(JSON.stringify(message))}\\);`,
            ),
        );
    assert.match(
        textured,
        new RegExp(
            `light\\.emission_texture->path\\.empty\\(\\)\\) \\{\\s*throw std::runtime_error\\(${regexText(JSON.stringify(processed))}\\);`,
        ),
    );
    assert.match(textured, /engine\.area_light_emission_installed = true;/);
});

test("processAreaLightTexture packages the pin's processing of its source's load", () => {
    const result = compileSource(`
import { createEngine, createRectAreaLight, loadTexture2D, processAreaLightTexture } from "@babylonjs/lite";
const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const engine = await createEngine(canvas);
const light = createRectAreaLight([0, 0, 0], 1, 1);
const source = await loadTexture2D(engine, "https://example.com/emitter.png", { srgb: false });
light.emissionTexture = await processAreaLightTexture(engine, source);
light.emissionTexture = null;
`);
    assert.ok(result.manifest.features.includes("light:rect-area-emission"));
    const image = result.manifest.assets.find(
        (asset) => asset.areaLightImage !== undefined,
    );
    assert.ok(image);
    assert.equal(image.source, areaLightImageSource(image.areaLightImage!));
    assert.match(image.output, /-emitter\.png$/);
    // The generated asset carries the load the bake replays.
    assert.deepEqual(image.areaLightImage, {
        source: "https://example.com/emitter.png",
        loaderOptions: { srgb: false },
    });
    assert.match(
        result.cpp,
        new RegExp(
            `bbl::set_rect_area_light_emission\\([^;]*bbl::process_area_light_texture\\([^;]*, bbl::asset_path\\("${image.output}"\\)\\)\\)\\);`,
        ),
    );
    assert.match(
        result.cpp,
        /bbl::set_rect_area_light_emission\([^;]*, nullptr\);/,
    );
    // Without enableRectAreaLights there is no lighting; with it, a scene
    // of the program can draw under any of them.
    assert.equal(reachedRectAreaLightings(result.manifest.features), undefined);
    assert.deepEqual(
        reachedRectAreaLightings([
            ...result.manifest.features,
            "light:rect-area-lighting",
        ]),
        rectAreaLightingModes,
    );
    assert.deepEqual(reachedRectAreaLightings(["light:rect-area-lighting"]), [
        "none",
        "solid",
    ]);
});

test("a processed image is named by its load", () => {
    const request: AreaLightImageRequest = {
        source: "https://example.com/a/Panel.png?x=1",
        loaderOptions: { srgb: false, minFilter: "nearest" },
    };
    const source = areaLightImageSource(request);
    assert.match(
        source,
        /^generated:pinned-area-light-texture\/[0-9a-f]{16}\/Panel\.png$/,
    );
    assert.equal(areaLightImageSource({ ...request }), source);
    // Another load of the same file is another image.
    assert.notEqual(
        areaLightImageSource({ ...request, loaderOptions: { srgb: true } }),
        source,
    );
    // The chain is the processed texture's own, which the scene array
    // copies level for level; the LTC tables are the pin's 64x64 rgba16f.
    assert.deepEqual(pinnedAreaLightImageShape(), { size: 1024, levels: 11 });
    assert.deepEqual(pinnedAreaLightLtcShape(), { size: 64, rowBytes: 512 });
});

test("a light is a tagged host: each write moving its world reaches the meshes under it", () => {
    // Upstream a mesh under a light composes the light's world as it is
    // now, and moving the light invalidates its children at once.
    const context = new LoweringContext();
    const hierarchy = lowerLightHierarchy(context).source;
    assert.match(
        hierarchy,
        /void set_mesh_light_parent\([\s\S]*?record\.light_parent = light;[\s\S]*?parent\.parented_meshes\.push_back\(mesh\);/,
    );
    // The node a light is parented to registers it, so that node's own
    // invalidation reaches the meshes under the light.
    assert.match(
        hierarchy,
        /void set_light_parent\([\s\S]*?registry->push_back\(light\);[\s\S]*?mark_light_children_dirty\(engine, record\);/,
    );
    assert.match(
        hierarchy,
        /void set_light_rotation_quaternion\([\s\S]*?mark_light_children_dirty\(engine, record\);/,
    );
    // No world-matrix provider snapshot: the light lane reads live.
    assert.doesNotMatch(hierarchy, /provider_world|live_provider/);
    // A position write marks the children only in a program with light
    // parents.
    assert.match(
        new LightLowerer(context, true).lowerPointFactory().source,
        /void set_point_light_position\([\s\S]*?mark_light_children_dirty\(engine, record\);/,
    );
    assert.doesNotMatch(
        new LightLowerer(context).lowerPointFactory().source,
        /mark_light_children_dirty/,
    );
});

test("the textured native half lowers the pin's image shape, snapshot and accessor", () => {
    const context = new LoweringContext();
    const solid = new RectAreaLightLowerer(context).lower().source;
    const textured = new RectAreaLightLowerer(context, true).lower().source;
    // The emissionTexture accessor: store and bump only on a change.
    assert.match(
        solid,
        /void set_rect_area_light_emission\([\s\S]*?if \(record\.emission_texture != image\)/,
    );
    assert.doesNotMatch(
        solid,
        /process_area_light_texture|prepare_area_light_emission/,
    );
    // The processed chain's shape; its texels stay in the package until
    // the backend's upload job reads them.
    const shape = pinnedAreaLightImageShape();
    assert.match(
        textured,
        new RegExp(
            `image->size = ${shape.size}u;\\s*image->levels = ${shape.levels}u;\\s*image->path = path;`,
        ),
    );
    assert.doesNotMatch(textured, /texels/);
    const capacity = pinnedMaxLights(context);
    assert.match(
        textured,
        new RegExp(
            `slots\\.assign\\(\\(${capacity}u \\+ 3u\\) / 4u \\* 4u, 0u\\);\\s*for_each_packed_light\\(scene, \\*scene\\.engine, ${capacity}u,`,
        ),
    );
    assert.match(textured, /emission->slots\[slot\] = layer \+ 1u;/);
    assert.match(
        textured,
        /prepare_area_light_emission\(scene\);\n {4}scene\.state->rect_area_lighting = true;/,
    );
    // Every build re-runs `_lighting._prepare()`: a changed image or light
    // set re-snapshots.
    assert.match(
        textured,
        /void refresh_rect_area_lighting\(Scene& scene\) \{[\s\S]*?prepare_area_light_emission\(scene\);/,
    );
});

test("an unchanged emission selection keeps the scene's snapshot", (t) => {
    // The pin's `same(state.allocation.snapshot, selected)`: a rebuild that
    // selects the same images in the same slots keeps the allocation, so no
    // backend re-uploads; a changed one replaces it, and no image clears it.
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    const prepare = cppFunction(
        new RectAreaLightLowerer(new LoweringContext(), true).lower().source,
        "void prepare_area_light_emission(Scene& scene) {",
    );
    runGeneratedProgram(
        tools,
        "rect-area-emission-snapshot",
        `
#include <bblite/runtime.hpp>
#include <cassert>
#include <stdexcept>
namespace bbl { ${prepare} }
int main(){
 bbl::Engine engine; bbl::Scene scene; scene.engine=&engine;
 for(std::uint32_t index=0;index<2;++index){
  engine.lights.emplace_back(); engine.lights[index].kind=bbl::LightKind::rect_area;
  scene.lights.push_back(bbl::LightHandle{index});
 }
 auto image=std::make_shared<bbl::AreaLightImage>(); image->path="emitter.png";
 engine.lights[1].emission_texture=image;
 bbl::prepare_area_light_emission(scene);
 const auto first=scene.state->area_light_emission;
 assert(first&&first->layers.size()==1&&first->slots[0]==0u&&first->slots[1]==1u);
 bbl::prepare_area_light_emission(scene);
 assert(scene.state->area_light_emission==first);
 engine.lights[0].emission_texture=image;
 bbl::prepare_area_light_emission(scene);
 assert(scene.state->area_light_emission!=first&&scene.state->area_light_emission->slots[0]==1u);
 engine.lights[0].emission_texture=nullptr; engine.lights[1].emission_texture=nullptr;
 bbl::prepare_area_light_emission(scene);
 assert(!scene.state->area_light_emission);
}
`,
        { timeoutMs: 10000, expectedOutput: "" },
    );
});

test("textured area PBR arms take the emission seam's lighting", async () => {
    const emission = await pinnedRectAreaEmissionPbr();
    const arms = await pinnedSceneArms({
        lightKinds: ["rectArea"],
        multiLight: true,
        noLight: false,
        toneMapping: [false],
        environment: false,
        fog: false,
        rectAreaLightings: rectAreaLightingModes,
    });
    // One set of arms per area lighting, each keyed by its mode's index.
    const textured = rectAreaLightingModes.indexOf("textured");
    const texturedArms = arms.filter((arm) => arm.areaLighting === textured);
    const single = texturedArms.find(
        (arm) => arm.singleLightType === "rectArea",
    );
    const multi = texturedArms.find((arm) => arm.lightMode === 2);
    const source = emission.rectAreaEmissionSingle("rectArea");
    assert.ok(single && multi && source);
    assert.equal(single.options.singleLightBlock, source.getSingleLightBlock());
    assert.equal(
        multi.options.multiLightLoop,
        emission.rectAreaEmissionMulti()._loop,
    );
    assert.match(multi.options.multiLightLoop ?? "", /roughness,lightIndex\)/);
    for (const arm of arms)
        assert.equal(
            (arm.options.sceneFeatures ?? 0) & emission.RECT_AREA_PBR_EMISSION,
            arm.areaLighting === textured ? emission.RECT_AREA_PBR_EMISSION : 0,
        );
    assert.deepEqual(
        [...new Set(arms.map((arm) => arm.areaLighting))].sort(),
        [0, 1, 2],
    );
});

test("textured Standard variants carry the emission word, bindings and both writers", async () => {
    const emission = await pinnedRectAreaEmissionStandard();
    const word =
        emission.rectAreaEmissionStandardContext(null)._materialFeatures;
    assert.equal(word, emission.rectAreaEmissionStdExt._feature);
    const lit = await composePinnedStandardVariant(
        {},
        { rectAreaLighting: "textured" },
    );
    const fragments = lit.fragmentKey.split("|");
    assert.ok(fragments.includes("rect-area-emission"));
    assert.ok(!fragments.includes("rect-area-light"));
    assert.equal(lit.features & word, word);
    const bindings = pinnedAreaLightEmissionBindings();
    assert.deepEqual(bindings, {
        texture: "areaEmission",
        sampler: "areaEmissionSampler",
        slots: "areaEmissionSlots",
    });
    assert.match(
        lit.fragmentWgsl,
        /var\s*areaEmission\s*:\s*texture_2d_array<f32>/,
    );
    assert.match(
        lit.fragmentWgsl,
        /evaluateAreaLtc\(N,viewDir,P,L,mat\._0,lightIndex\)/,
    );
    // SDL_GPU's four uniform slots go to scene, lights, mesh and mat; the
    // slot block is the one the shader compile may demote.
    assert.ok(
        demotableUniformBlocks(lit.fragmentWgsl).includes(bindings.slots),
    );
    const context = new LoweringContext();
    const writers = await standardExtensionWriters(rectAreaLightingModes);
    // Both registered area writers run, in `_getStdExtsSorted()` order.
    assert.deepEqual(
        writers.map((writer) => writer.symbolName),
        ["rectAreaEmissionStdExt._writeUbo", "rectAreaStdExt._writeUbo"],
    );
    const header = inlineCpp(
        pinnedStandardVariantsHeader(
            context,
            "test",
            [pinnedStandardVariantManifestEntry(lit)],
            false,
            writers,
        ),
    );
    assert.equal(
        header.match(/out\._0 = static_cast<float>\(material\.roughness\);/g)
            ?.length,
        2,
    );
    const support = inlineCpp(
        pinnedStandardSupportBlock(context, {
            rectAreaLighting: {
                lightings: rectAreaLightingModes,
                materialFeatures: { textured: word },
            },
            selectors: [],
            uvTransform: false,
            plugins: false,
            renderableMeshFeatures: [],
        }),
    );
    // The word follows the scene's own area lighting.
    assert.match(
        support,
        new RegExp(
            `switch \\(scene_rect_area_lighting\\(scene\\)\\) \\{\\s*case 2u:\\s*return ${word}u;\\s*default:\\s*return 0u;`,
        ),
    );
    assert.match(
        support,
        new RegExp(
            `"${bindings.texture}", "${bindings.sampler}",[\\s\\S]*?rect_area_emission`,
        ),
    );
});

test("the packaged LTC tables are the pin's decode of its own payload", async () => {
    assert.match(pinnedAreaLightLtcUrl(), /^https:\/\/.*\.bin$/);
    // Word w of the payload is w: LTC1 texel i channel c is word i*8+c and
    // LTC2's is word i*8+4+c, little-endian, bits unchanged.
    const payload = new Uint8Array(65536);
    const view = new DataView(payload.buffer);
    for (let word = 0; word < 32768; word++)
        view.setUint16(word * 2, word, true);
    const [ltc1, ltc2] = await decodeAreaLightLtcTables(payload);
    const words = (table: Uint8Array): Uint16Array =>
        new Uint16Array(table.buffer, table.byteOffset, table.byteLength / 2);
    assert.equal(ltc1.byteLength, 64 * 64 * 8);
    for (const texel of [0, 1, 2047, 4095])
        for (let channel = 0; channel < 4; channel++) {
            assert.equal(words(ltc1)[texel * 4 + channel], texel * 8 + channel);
            assert.equal(
                words(ltc2)[texel * 4 + channel],
                texel * 8 + 4 + channel,
            );
        }
    await assert.rejects(
        decodeAreaLightLtcTables(new Uint8Array(65535)),
        (error: unknown) =>
            error instanceof Error &&
            error.message.includes(
                pinnedError(
                    "RectAreaLight: LTC payload must contain 65536 bytes, got ${a0}",
                ),
            ),
    );
});

test("the LTC slot rows are the pin's areaLightBindings pairs", async () => {
    const { areaLightBindings } = await importPinnedModule<{
        areaLightBindings: () => { _name: string }[];
    }>("light/area-light-wgsl.js");
    const names = areaLightBindings().map((binding) => binding._name);
    assert.deepEqual(
        pinnedAreaLightBindingPairs().flatMap((pair) => [
            pair.texture,
            pair.sampler,
        ]),
        names,
    );
});

test("area-enabled PBR arms take the scene's lighting extension", async () => {
    const area = await pinnedRectAreaPbr();
    const request = {
        lightKinds: ["rectArea"] as const,
        multiLight: true,
        noLight: false,
        toneMapping: [false],
        environment: false,
        fog: false,
    };
    const arms = await pinnedSceneArms({
        ...request,
        rectAreaLightings: ["none", "solid"],
    });
    const solid = arms.filter((arm) => arm.areaLighting === 1);
    const single = solid.find((arm) => arm.singleLightType === "rectArea");
    const multi = solid.find((arm) => arm.lightMode === 2);
    const source = area.rectAreaSingleLightSource("rectArea");
    assert.ok(single && multi && source);
    assert.equal(single.options.singleLightBlock, source.getSingleLightBlock());
    assert.equal(
        multi.options.multiLightLoop,
        area.rectAreaMultiLightSource()._loop,
    );
    // The key carries the scene bit; the selected bit only gates the
    // layered refusal, which each area arm's renderables compose once more
    // under (`areaSelectedFeatures`).
    for (const arm of solid) {
        const features = arm.options.sceneFeatures ?? 0;
        assert.equal(
            features & area.RECT_AREA_PBR_SCENE,
            area.RECT_AREA_PBR_SCENE,
        );
        assert.equal(features & area.RECT_AREA_PBR_SELECTED, 0);
        assert.equal(
            arm.areaSelectedFeatures,
            features | area.RECT_AREA_PBR_SELECTED,
        );
    }
    // A scene of the program that never enabled area lighting draws with
    // the ordinary arms.
    const unlit = arms.filter((arm) => arm.areaLighting === 0);
    assert.ok(unlit.length > 0);
    for (const arm of unlit) {
        assert.equal(
            (arm.options.sceneFeatures ?? 0) & area.RECT_AREA_PBR_SCENE,
            0,
        );
        assert.equal(arm.areaSelectedFeatures, undefined);
        assert.notEqual(arm.singleLightType, "rectArea");
    }
    // Without the opt-in a rectangular light has no single source: its own
    // _validateLighting refuses the scene at registration.
    const plain = await pinnedSceneArms(request);
    assert.ok(plain.every((arm) => arm.areaLighting === undefined));
    assert.ok(!plain.some((arm) => arm.singleLightType === "rectArea"));
    assert.ok(
        plain.every(
            (arm) =>
                ((arm.options.sceneFeatures ?? 0) &
                    area.RECT_AREA_PBR_SCENE) ===
                0,
        ),
    );
});

test("area-enabled Standard variants carry the scene word, LTC rows and roughness lane", async () => {
    const standard = await pinnedRectAreaStandard();
    const word = standard.rectAreaStandardContext(null)._materialFeatures;
    assert.equal(word, standard.rectAreaStdExt._feature);
    const lit = await composePinnedStandardVariant(
        {},
        { rectAreaLighting: "solid" },
    );
    assert.ok(lit.fragmentKey.split("|").includes("rect-area-light"));
    assert.equal(lit.features & word, word);
    assert.match(lit.fragmentWgsl, /evaluateAreaLtc\(N,viewDir,P,L,mat\._0\)/);
    const plain = await composePinnedStandardVariant({}, {});
    assert.equal(plain.features & word, 0);
    assert.doesNotMatch(plain.fragmentWgsl, /areaLtc/);
    // rectAreaStdExt._writeUbo stores the roughness at material float 22,
    // which the mirrored block names `_0`.
    const { rectAreaStdExt } = await importPinnedModule<{
        rectAreaStdExt: {
            _writeUbo(data: Float32Array, material: object): void;
        };
    }>("material/standard/fragments/rect-area-light-fragment.js");
    const data = new Float32Array(24);
    rectAreaStdExt._writeUbo(data, { roughness: 0.3 });
    assert.equal(data[22], Math.fround(0.3));
    const context = new LoweringContext();
    const entry = pinnedStandardVariantManifestEntry(lit);
    const header = inlineCpp(
        pinnedStandardVariantsHeader(
            context,
            "test",
            [entry],
            false,
            await standardExtensionWriters(["none", "solid"]),
        ),
    );
    assert.match(
        header,
        /out\._0 = static_cast<float>\(material\.roughness\);/,
    );
    assert.match(header, /offsetof\(StandardMaterialUniforms, _0\) == 88/);
    const support = inlineCpp(
        pinnedStandardSupportBlock(context, {
            rectAreaLighting: {
                lightings: ["none", "solid"],
                materialFeatures: { solid: word },
            },
            selectors: [],
            uvTransform: false,
            plugins: false,
            renderableMeshFeatures: [],
        }),
    );
    assert.match(
        support,
        new RegExp(
            `switch \\(scene_rect_area_lighting\\(scene\\)\\) \\{\\s*case 1u:\\s*return ${word}u;\\s*default:\\s*return 0u;`,
        ),
    );
    assert.match(support, /props\.roughness = material\.standard_roughness;/);
    assert.doesNotMatch(support, /rect_area_emission/);
    // The program's writers: none without the opt-in.
    assert.deepEqual(await standardExtensionWriters(undefined), []);
    for (const pair of pinnedAreaLightBindingPairs())
        assert.match(
            support,
            new RegExp(
                `"${pair.texture}", "${pair.sampler}",[\\s\\S]*?rect_area_ltc`,
            ),
        );
    assert.doesNotMatch(
        inlineCpp(pinnedStandardVariantsHeader(context, "test", [entry])),
        /material\.roughness/,
    );
});
