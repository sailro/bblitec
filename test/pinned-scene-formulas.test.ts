import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { doubleCpp } from "../src/cpp-literals.js";
import { compileSource } from "../src/compiler.js";
import { BillboardLowerer } from "../src/lowering/billboard-lowerer.js";
import {
    sharedPinnedContext,
    type LoweringContext,
} from "../src/lowering/context.js";
import { EnvironmentLowerer } from "../src/lowering/environment-lowerer.js";
import { LightLowerer } from "../src/lowering/light-lowerer.js";
import { lowerWorldAabbHelpers } from "../src/lowering/world-bounds-lowerer.js";
import {
    createJavaScriptFunction,
    transpileCommonJs,
} from "../src/typescript-transpile.js";
import { doctoredContext } from "./doctored-store.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const sizeModule = "src/material/pbr/scene-size.ts";
const spriteModule = "src/sprite/billboard-sprite.ts";
const lightModule = "src/light/spot-light.ts";
const tuple = (values: readonly number[]): string =>
    `{${values.map(doubleCpp).join(", ")}}`;
const optional = (value: number | undefined): string =>
    value === undefined ? "std::nullopt" : doubleCpp(value);

function declarationSource(
    context: LoweringContext,
    module: string,
    name: string,
): string {
    const { file, declaration } = context.functionDeclaration(module, name);
    return transpileCommonJs(declaration.getText(file), module);
}

function axisReference(
    context: LoweringContext,
): (axis: readonly number[]) => number[] {
    const exports = {} as {
        createAxisLockedBillboardSystem(
            atlas: unknown,
            axis: readonly number[],
        ): number[];
    };
    createJavaScriptFunction(
        "exports",
        "createBillboardSystem",
        "ThrowLiteError",
        declarationSource(
            context,
            spriteModule,
            "createAxisLockedBillboardSystem",
        ),
    )(
        exports,
        (_atlas: unknown, _kind: unknown, axis: number[]) => axis,
        (code: number) => {
            throw new Error(`#${code}`);
        },
    );
    return (axis) => exports.createAxisLockedBillboardSystem({}, axis);
}

test("scene sizing, billboard axes and spot accessors execute their pinned bodies", (t) => {
    const tools = optionalNativeFixtureTools();
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    const context = sharedPinnedContext();
    const variants = [
        context,
        doctoredContext(
            sizeModule,
            "sceneDiagonalLength > groundSize",
            "sceneDiagonalLength >= groundSize",
        ),
        doctoredContext(sizeModule, "groundSize *= 1.1", "groundSize *= 1.25"),
    ];
    const boundsExports: Record<string, unknown> = {};
    createJavaScriptFunction(
        "exports",
        transpileCommonJs(
            context.sourceFile("src/mesh/mesh-world-bounds.ts").text,
            "bounds.ts",
        ),
    )(boundsExports);
    const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const boxes = [
        [],
        [{ min: [0, 0, 0], max: [9, 12, 0] }],
        [
            { min: [-1, -2, -3], max: [2, 4, 6] },
            { min: [-7, 0, -1], max: [1, 8, 3] },
        ],
    ];
    const sizes = [undefined, 0, -7, NaN, Infinity, 23];
    const cameras: (undefined | { upperRadiusLimit?: number | undefined })[] = [
        undefined,
        {},
        ...[undefined, 0, NaN, -2, 5, 20, Infinity].map((upperRadiusLimit) => ({
            upperRadiusLimit,
        })),
    ];
    const programs: string[] = [];
    const checks: string[] = [];
    for (const [version, pin] of variants.entries()) {
        const exports = {} as {
            computeSceneSize(
                scene: unknown,
                size?: number,
            ): {
                groundSize: number;
                skyboxSize: number;
                rootPosition: number[];
            };
        };
        createJavaScriptFunction(
            "exports",
            "emptyWorldAabb",
            "expandWorldAabbForMesh",
            declarationSource(pin, sizeModule, "computeSceneSize"),
        )(
            exports,
            boundsExports.emptyWorldAabb,
            boundsExports.expandWorldAabbForMesh,
        );
        programs.push(
            `namespace size_${version} { ${new EnvironmentLowerer(pin).lowerSceneSize()} }`,
        );
        for (const box of boxes)
            for (const size of sizes)
                for (const camera of cameras) {
                    const meshes = box.map(({ min, max }) => ({
                        boundMin: new Float32Array(min),
                        boundMax: new Float32Array(max),
                        worldMatrix: new Float32Array(matrix),
                    }));
                    const expected = exports.computeSceneSize(
                        { meshes, camera },
                        size,
                    );
                    const cameraCpp =
                        camera === undefined
                            ? "scene.camera = 1;"
                            : `scene.camera = 0; engine.cameras[0].kind = CameraKind::${"upperRadiusLimit" in camera ? "arc_rotate" : "other"}; engine.cameras[0].upper_radius_limit = ${optional("upperRadiusLimit" in camera ? camera.upperRadiusLimit : undefined)};`;
                    checks.push(`{ Scene scene; Engine engine; scene.engine = &engine; ${cameraCpp}
                ${box.map(({ min, max }) => `scene.meshes.push_back(WorldAabbMesh{std::array<float, 3>${tuple(min)}, std::array<float, 3>${tuple(max)}, std::array<float, 16>${tuple(matrix)}, false, {}, 0.0});`).join("\n")}
                const auto result = size_${version}::compute_scene_size(scene, ${optional(size)});
                same(result.ground_size, ${doubleCpp(expected.groundSize)}); same(result.skybox_size, ${doubleCpp(expected.skyboxSize)});
                ${expected.rootPosition.map((value, lane) => `same(result.root_position[${lane}], ${doubleCpp(value)});`).join(" ")}
            }`);
                }
    }
    const axisVariants = [
        context,
        doctoredContext(spriteModule, "lengthSq < 1e-8", "lengthSq < 1e-6"),
    ];
    for (const [version, pin] of axisVariants.entries()) {
        const reference = axisReference(pin);
        programs.push(
            `namespace axis_${version} { ${new BillboardLowerer(pin).lowerAxisNormalization()} }`,
        );
        for (const axis of [
            [0, 0, 0],
            [1e-4, 0, 0],
            [1e-3, 0, 0],
            [2, -3, 4],
            [1e308, 0, 0],
            [Infinity, 0, 0],
            [NaN, 1, 2],
            [-0, -4, 0],
        ]) {
            let expected: number[];
            try {
                expected = reference(axis);
            } catch (error) {
                assert.ok(error instanceof Error);
                checks.push(
                    `{ bool refused = false; try { (void)axis_${version}::normalize_billboard_axis(${tuple(axis)}); } catch(const std::runtime_error& error) { refused = std::string(error.what()) == ${JSON.stringify(error.message)}; } assert(refused); }`,
                );
                continue;
            }
            checks.push(
                `{ const auto result = axis_${version}::normalize_billboard_axis(${tuple(axis)}); ${expected.map((value, lane) => `same(result[${lane}], ${doubleCpp(value)});`).join(" ")} }`,
            );
        }
    }
    const lightVariants = [
        context,
        doctoredContext(lightModule, "Math.cos(v * 0.5)", "Math.cos(v * 0.25)"),
    ];
    for (const [version, pin] of lightVariants.entries()) {
        interface Spot {
            angle: number;
            _writeLightUbo(data: Float32Array, offset: number): void;
        }
        const exports = {} as {
            createSpotLight(
                position: number[],
                direction: number[],
                angle: number,
                exponent: number,
            ): Spot;
        };
        createJavaScriptFunction(
            "exports",
            "createLightBase",
            "applyLightBase",
            "ObservableVec3",
            "writeWorldLightDirection",
            declarationSource(pin, lightModule, "createSpotLight"),
        )(
            exports,
            () => ({ node: {}, lvs: { b() {} } }),
            (_node: unknown, light: Spot) =>
                Object.assign(light, { worldMatrix: new Float32Array(matrix) }),
            class {},
            () => {},
        );
        programs.push(
            `namespace light_${version} { ${new LightLowerer(pin).lowerSpotAngleSetter()} }`,
        );
        for (const initial of [-0, 0.6, NaN]) {
            const light = exports.createSpotLight(
                [0, 0, 0],
                [0, 1, 0],
                initial,
                1,
            );
            const output = new Float32Array(16);
            light._writeLightUbo(output, 0);
            const steps = [
                `LightRecord light; light_${version}::initialize_spot_light_cone(light, ${doubleCpp(initial)});`,
                `same(light.angle, ${doubleCpp(light.angle)}); same(light.cos_half_angle, ${doubleCpp(output[15]!)});`,
            ];
            for (const angle of [
                initial,
                0,
                -0,
                0.7,
                0.7,
                NaN,
                Infinity,
                1.2,
            ]) {
                light.angle = angle;
                light._writeLightUbo(output, 0);
                steps.push(
                    `light_${version}::refresh_spot_light_cone(light, ${doubleCpp(angle)}); same(light.angle, ${doubleCpp(light.angle)}); same(light.cos_half_angle, ${doubleCpp(output[15]!)});`,
                );
            }
            checks.push(`{ ${steps.join("\n")} }`);
        }
    }
    const directory = resolve("artifacts/test-pinned-scene-formulas");
    mkdirSync(directory, { recursive: true });
    const source = join(directory, "check.cpp"),
        executable = join(directory, "check.exe");
    writeFileSync(
        source,
        `#include <bblite/js_data.hpp>
#include <cassert>
#include <cmath>
#include <limits>
struct MeshRecord { bool thin_instance_world_bounds = false; std::vector<std::array<float, 16>> instance_matrices; std::size_t instance_count = 0; };
${lowerWorldAabbHelpers(context, { emptyAccumulator: true })}
enum class CameraKind { arc_rotate, other };
struct Camera { CameraKind kind = CameraKind::other; std::optional<double> upper_radius_limit; };
struct Engine { std::vector<Camera> cameras{1}; };
struct Scene { Engine* engine = nullptr; std::size_t camera = 0; std::vector<WorldAabbMesh> meshes; };
namespace bbl { const Camera* handle_find(const std::vector<Camera>& cameras, std::size_t index) { return index < cameras.size() ? &cameras[index] : nullptr; } }
void expand_scene_mesh_bounds(WorldAabb& acc, const Scene&, const WorldAabbMesh& mesh) { expand_world_aabb_for_mesh(acc, mesh); }
struct LightRecord { double angle = 0.0; float cos_half_angle = 1.0f; };
${programs.join("\n")}
void same(double actual, double expected) { if (std::isnan(expected)) assert(std::isnan(actual)); else { assert(actual == expected); if (actual == 0.0) assert(std::signbit(actual) == std::signbit(expected)); } }
int main() { ${checks.join("\n")} }
`,
    );
    runNativeFixtureCompiler(tools, [
        "/O2",
        `/Fo:${directory}/`,
        `/Fe:${executable}`,
        source,
    ]);
    execFileSync(executable, [], { cwd: directory, stdio: "pipe" });
});

test("environment options preserve nullish absence and explicit numeric sizes", () => {
    for (const size of ["undefined", "null", "0", "-7", "NaN"]) {
        const compiled =
            compileSource(`import { createEngine, createSceneContext, loadEnvironment } from "babylon-lite";
            async function main() { const engine = await createEngine({}); const scene = createSceneContext(engine);
                await loadEnvironment(scene, "environment.env", { skyboxSize: ${size} }); } main();`);
        assert.match(compiled.cpp, /Nullable<double>\{.*\}\.to_optional\(\)/);
        assert.doesNotMatch(compiled.cpp, /skybox_size > 0/);
    }
});

test("compiled billboard factory calls retain input doubles through normalization", (t) => {
    const tools = optionalNativeFixtureTools();
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    const context = sharedPinnedContext();
    const core = new BillboardLowerer(context).lowerCore();
    const reference = axisReference(context);
    const checks = [
        [1e100, 2e100, 3e100],
        [1e308, 0, 0],
        [1e-4, 0, 0],
        [0, 0, 0],
        [Infinity, 0, 0],
    ].map((axis) => {
        const compiled =
            compileSource(`import {createEngine, loadSpriteAtlas, createAxisLockedBillboardSystem} from "babylon-lite";
            async function main() { const engine = await createEngine({}); const atlas = await loadSpriteAtlas(engine, "sprites.png", {gridSize:[1,1]});
            const system = createAxisLockedBillboardSystem(atlas, [${axis.map(String).join(",")}]); } main();`);
        const call = compiled.cpp
            .split("\n")
            .find((line) => line.includes(" = bbl::create_billboard_system("));
        assert.ok(call);
        let expected: number[];
        try {
            expected = reference(axis);
        } catch (error) {
            assert.ok(error instanceof Error);
            return `{ bool refused = false; try { ${call} } catch (const std::runtime_error& error) { refused = std::string(error.what()) == ${JSON.stringify(error.message)}; } assert(refused); }`;
        }
        return `{ ${call} const auto& result = v_engine.billboard_systems[v_system.value].axis;
            ${expected.map((value, lane) => `assert(result.${["x", "y", "z"][lane]} == ${doubleCpp(Math.fround(value))});`).join("\n")} }`;
    });
    const directory = resolve("artifacts/test-pinned-billboard-input-width");
    mkdirSync(directory, { recursive: true });
    const source = join(directory, "check.cpp"),
        executable = join(directory, "check.exe");
    const anchor = core.header
        .split("\n")
        .find((line) =>
            line.startsWith(
                "inline constexpr std::uint32_t billboard_anchor_floats_per_sprite",
            ),
        );
    assert.ok(anchor);
    writeFileSync(
        source,
        `#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <cassert>
namespace bbl::upstream {
${anchor}
${core.header.match(/inline constexpr std::uint32_t billboard_saved_size_floats_per_sprite = \d+u;/)![0]}
${cppFunction(core.header, "inline double billboard_system_order(")}
}
namespace bbl {
${cppFunction(core.header, "inline SpriteBlendDescriptor billboard_blend_alpha(")}
${cppFunction(core.source, "std::array<double, 3> normalize_billboard_axis(")}
${cppFunction(core.source, "static void resize_billboard_storage(")}
${cppFunction(core.source, "BillboardSystemHandle create_billboard_system(")}
}
int main() { bbl::Engine v_engine; v_engine.sprite_atlases.emplace_back(); const bbl::SpriteAtlasHandle v_atlas{0}; ${checks.join("\n")}
    for (const double capacity : {std::numeric_limits<double>::quiet_NaN(), std::numeric_limits<double>::infinity(), 4294967296.0, 1.5}) {
        bbl::BillboardSystemOptions options; options.capacity = capacity;
        bool refused = false;
        try { (void)bbl::create_billboard_system(v_engine, v_atlas, bbl::BillboardOrientation::facing, {}, options); }
        catch (const std::runtime_error&) { refused = true; }
        assert(refused);
    }
}
`,
    );
    runNativeFixtureCompiler(tools, [
        "/O2",
        `/Fo:${directory}/`,
        `/Fe:${executable}`,
        source,
    ]);
    execFileSync(executable, [], { cwd: directory, stdio: "pipe" });
});
