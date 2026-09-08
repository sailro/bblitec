import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { LoweringContext } from "../src/lowering/context.js";
import { pinnedCsmFunctions } from "../src/lowering/pinned-csm.js";
import { pinnedShadowHeader } from "../src/lowering/shadow-lowerer.js";
import { pinnedWorldTransformHeader } from "../src/lowering/pinned-world-transform.js";
import { importPinnedModule, importPinnedModuleWithExports } from "../src/pinned-shader-composer.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const csmModule = "src/shadow/csm-shadow-task-hooks.ts";
const context = new LoweringContext();

class ChangedCsmContext extends LoweringContext {
    private changed: ts.SourceFile | undefined;

    public constructor(private readonly change: (source: string) => string) {
        super(context.store);
    }

    public override sourceFile(modulePath: string): ts.SourceFile {
        const source = super.sourceFile(modulePath);
        if (modulePath !== csmModule) return source;
        this.changed ??= ts.createSourceFile(modulePath, this.change(source.text), ts.ScriptTarget.Latest, true);
        return this.changed;
    }
}

test("CSM emits the pinned fitting, coordinate, caster and receiver bodies", () => {
    const header = pinnedShadowHeader(context);
    for (const symbol of [
        "_computeCsmCascades", "transformCoordInto", "_castersWorldAabbInto",
        "_thinInstanceWorldAabb", "_writeCsmUbo", "_biasViewProjection",
    ]) assert.ok(header.includes(`${csmModule}#${symbol}`), symbol);
    assert.match(header, /csm_compute_cascades\(\s*aspect, camera, light, cfg, casters, scratch,/);
    assert.match(header, /csm_write_ubo\(packed, columns, csm_config\(generator\)\)/);
    assert.doesNotMatch(header, /const auto transform_point|caster_min_x|previous_split/);
});

test("CSM lowers changed arithmetic and renamed aliases instead of asserting a transcript", () => {
    const original = pinnedCsmFunctions(context);
    const changed = pinnedCsmFunctions(new ChangedCsmContext((source) => source
        .replace("const d = cfg._lambda * (log - uniform) + uniform;",
            "const d = cfg._lambda * (log - uniform) + uniform + 0.125;")
        .replace(/\bcorners\b/g, "frustumPoints")
        .replace(/\bnearCorner\b/g, "startPoint")
        .replace(/\bfarCorner\b/g, "endPoint")));
    assert.notEqual(changed, original);
    assert.match(changed, /const double d = .*0\.125/);
    const geometry = pinnedCsmFunctions(new ChangedCsmContext((source) => source
        .replace("const ix = mats[o]! * lx", "const ix = 1.125 * mats[o]! * lx")));
    assert.notEqual(geometry, original);
    assert.match(geometry, /const double ix = .*1\.125/);
    assert.throws(() => pinnedCsmFunctions(new ChangedCsmContext((source) => source
        .replace("const d = cfg._lambda * (log - uniform) + uniform;",
            "const d = unloweredSplit(log, uniform);"))), /csm-shadow-task-hooks\.ts:\d+:\d+:.*unloweredSplit/);
});

test("CSM rejects changed storage widths and unlowered cache-side work", () => {
    assert.throws(() => pinnedCsmFunctions(new ChangedCsmContext((source) => source
        .replace("_invViewProj: Float32Array;", "_invViewProj: Float64Array;"))), /Pinned CSM storage changed/);
    assert.throws(() => pinnedCsmFunctions(new ChangedCsmContext((source) => source
        .replace("const cache = _getThinCasterAabbCache();",
            "const cache = _getThinCasterAabbCache(), extra = adjustBounds(mesh);"))), /Unexpected work.*cache prelude/);
});

interface Vector { x: number; y: number; z: number }
interface PinCamera {
    nearPlane: number;
    farPlane: number;
    viewport?: { x: number; y: number; width: number; height: number };
    _vpCache: Float32Array | Float64Array;
}
interface PinCaster {
    worldMatrix: Float64Array;
    boundMin: Float32Array;
    boundMax: Float32Array;
    worldMatrixVersion: number;
    thinInstances?: { matrices: Float32Array; count: number; _version: number };
}
interface PinConfig {
    _numCascades: number;
    _lambda: number;
    _cascadeBlendPercentage: number;
    _stabilizeCascades: boolean;
    _shadowMaxZ: number | null;
    _bias: number;
    _worldSpaceBias: number | null;
    _darkness: number;
    _frustumEdgeFalloff: number;
    _mapSize: number;
    _forceRefreshEveryFrame: boolean;
}
interface PinCascades {
    _transforms: Float32Array[];
    _views: Float32Array[];
    _near: number[];
    _far: number[];
    _viewFrustumZ: number[];
    _frustumLengths: number[];
}
interface PinScratch {
    _cascades: PinCascades;
    _corners: number[][];
    _aabb: number[];
    _view: Float32Array;
    _invViewProj: Float32Array;
}
interface PinCsm {
    _createCascadeScratch: (count: number) => PinScratch;
    _computeCsmCascades: (
        scene: { surface: { scRT: { _width: number; _height: number } } },
        camera: PinCamera, light: { direction: Vector }, config: PinConfig,
        casters: readonly PinCaster[], scratch: PinScratch,
    ) => PinCascades;
    _castersWorldAabbInto: (casters: readonly PinCaster[], scratch: PinScratch) => boolean;
    _writeCsmUbo: (out: Float32Array, cascades: PinCascades, config: PinConfig) => void;
    _biasViewProjection: (matrix: Float32Array, bias: number) => void;
    csmWorldBiasClipOffset: (bias: number, near: number, far: number) => number;
    transformCoordInto: (out: number[], matrix: ArrayLike<number>, x: number, y: number, z: number) => void;
}

function cppNumber(value: number): string {
    const bits = new BigUint64Array(Float64Array.of(value).buffer)[0]!;
    return `std::bit_cast<double>(${bits}ull)`;
}

function cppArray(value: ArrayLike<number>, width: "float" | "double" = "double"): string {
    const lanes = Array.from(value);
    return `std::array<${width}, ${lanes.length}>{${lanes.map((lane) => width === "float"
        ? `std::bit_cast<float>(${new Uint32Array(Float32Array.of(lane).buffer)[0]}u)`
        : cppNumber(lane)).join(", ")}}`;
}

function casterInput(caster: PinCaster): string[] {
    const matrices = caster.thinInstances;
    const base = `${cppArray(caster.worldMatrix)}, `;
    const bounds = `, ${cppArray(caster.boundMin, "float")}, ${cppArray(caster.boundMax, "float")}`;
    if (!matrices) return [`ShadowCaster{${base}{}, false${bounds}}`];
    return Array.from({ length: matrices.count }, (_, index) =>
        `ShadowCaster{${base}${cppArray(matrices.matrices.subarray(index * 16, index * 16 + 16), "float")}, true${bounds}}`);
}

function casters(parked = false): PinCaster[] {
    const world = Float64Array.of(
        -1, 0.125, 0, 0, 0.3, 0.75, -0.125, 0,
        0, 0.25, 1.125, 0, 1000000.0001220703, -2.125, 0.125, 1,
    );
    const first: PinCaster = {
        worldMatrix: world, worldMatrixVersion: 1,
        boundMin: Float32Array.of(-0.25, -0.375, -0.75),
        boundMax: Float32Array.of(0.625, 1.375, 0.125),
    };
    const second: PinCaster = {
        ...first,
        worldMatrix: Float64Array.from(world),
        thinInstances: {
            matrices: Float32Array.of(
                parked ? 1e-9 : 0.75, 0, 0, 0, 0, parked ? 0 : -1.25, 0, 0,
                0, 0, parked ? 0 : 1.5, 0, -17.25, 2.625, -5.125, 1,
                parked ? 1.0000001e-9 : -0.875, 0.125, 0, 0, 0, 0.75, 0.25, 0,
                0.3, 0, 1.125, 0, 3.375, -1.25, 7.125, 1,
            ),
            count: 2, _version: 1,
        },
    };
    if (parked) second.thinInstances!.matrices.fill(0, 17, 28);
    return [first, second];
}

const nativeTools = optionalNativeFixtureTools();
test("compiled CSM matches the executed pin across fitting, widths and degenerate boundaries", {
    skip: !nativeTools,
}, async () => {
    const pin = await importPinnedModuleWithExports<PinCsm>("shadow/csm-shadow-task-hooks.js",
        ["_castersWorldAabbInto", "transformCoordInto"]);
    const { createFreeCamera } = await importPinnedModule<{
        createFreeCamera: (position: Vector, target: Vector) => PinCamera;
    }>("camera/free-camera.js");
    const { getViewProjectionMatrix } = await importPinnedModule<{
        getViewProjectionMatrix: (camera: PinCamera, aspect: number) => ArrayLike<number>;
    }>("camera/camera.js");
    const { mat4InvertToRefOrIdentity } = await importPinnedModule<{
        mat4InvertToRefOrIdentity: (input: Float64Array, out: Float32Array) => void;
    }>("math/mat4-invert-to-ref.js");
    const cases: string[] = [];
    const variants = [
        {}, { count: 1, lambda: 0 }, { count: 2, lambda: 1, maxZ: 25 },
        { maxZ: 1 }, { maxZ: 1 - Number.EPSILON }, { maxZ: 100 },
        { direction: { x: 0, y: -1, z: 0 } },
        { direction: { x: 0, y: 0, z: 0 }, empty: true },
        { stabilize: true }, { stabilize: true, worldBias: 0.25 },
        { worldBias: 0 }, { empty: true }, { parked: true },
        { wide: true, viewport: true },
    ];
    for (const [index, variant] of variants.entries()) {
        const camera = createFreeCamera({ x: 1000002.125, y: 3.375, z: -8.25 },
            { x: 1000000.125, y: 0.25, z: 0.125 });
        camera.nearPlane = 1;
        camera.farPlane = 100;
        if (variant.viewport) camera.viewport = { x: 0.1, y: 0, width: 0.75, height: 0.5 };
        const aspect = (1280 / 720) * (variant.viewport ? 1.5 : 1);
        let projection = getViewProjectionMatrix(camera, aspect);
        if (variant.wide) {
            camera._vpCache = Float64Array.from(projection, (lane, cell) => lane + (cell === 12 ? 0.0001220703125 : 0));
            projection = camera._vpCache;
        }
        const config: PinConfig = {
            _numCascades: variant.count ?? 4,
            _lambda: variant.lambda ?? 0.5,
            _cascadeBlendPercentage: index % 2 ? 0 : 0.1,
            _stabilizeCascades: variant.stabilize ?? false,
            _shadowMaxZ: variant.maxZ ?? null,
            _bias: 0.00005, _worldSpaceBias: variant.worldBias ?? null,
            _darkness: 0.125, _frustumEdgeFalloff: 0.03125,
            _mapSize: 1024, _forceRefreshEveryFrame: false,
        };
        const direction = variant.direction ?? { x: -1, y: -2, z: -2 };
        const inputs = variant.empty ? [] : casters(variant.parked);
        const scratch = pin._createCascadeScratch(config._numCascades);
        const expected = pin._computeCsmCascades(
            { surface: { scRT: { _width: 1280, _height: 720 } } },
            camera, { direction }, config, inputs, scratch);
        const ubo = new Float32Array(80);
        pin._writeCsmUbo(ubo, expected, config);
        const fitted = expected._transforms.map((matrix, cascade) => {
            const biased = new Float32Array(matrix);
            const clipBias = config._worldSpaceBias === null ? config._bias * 0.5
                : pin.csmWorldBiasClipOffset(config._worldSpaceBias, expected._near[cascade]!, expected._far[cascade]!);
            pin._biasViewProjection(biased, clipBias);
            return `same(actual._transforms[${cascade}], ${cppArray(matrix, "float")});
    same(actual._views[${cascade}], ${cppArray(expected._views[cascade]!, "float")});
    auto biased_${cascade} = actual._transforms[${cascade}];
    csm_bias_view_projection(biased_${cascade}, csm_caster_clip_bias(cfg, actual, ${cascade}));
    same(biased_${cascade}, ${cppArray(biased, "float")});`;
        }).join("\n");
        cases.push(`{
    case_number = ${index};
    const std::vector<ShadowCaster> inputs{${inputs.flatMap(casterInput).join(", ")}};
    const CsmConfig cfg{${config._numCascades}, ${cppNumber(config._lambda)}, ${cppNumber(config._cascadeBlendPercentage)},
        ${config._stabilizeCascades}, ${config._shadowMaxZ === null ? "std::nullopt" : cppNumber(config._shadowMaxZ)},
        ${cppNumber(config._bias)}, ${config._worldSpaceBias === null ? "std::nullopt" : cppNumber(config._worldSpaceBias)},
        ${config._darkness}, ${config._frustumEdgeFalloff}, ${config._mapSize}, false};
    CsmCascadeScratch scratch(${config._numCascades});
    const Camera camera{1, 100};
    const Light light{{${[direction.x, direction.y, direction.z].map(cppNumber).join(", ")}}};
    const auto projection = ${cppArray(projection, variant.wide ? "double" : "float")};
    const auto& actual = csm_compute_cascades(${cppNumber(aspect)}, camera, light, cfg, inputs, scratch,
        [&](const Camera&, double fitted_aspect) { assert(fitted_aspect == ${cppNumber(aspect)}); return projection; });
    std::array<float, 80> ubo{};
    csm_write_ubo(ubo, actual, cfg);
    same(ubo, ${cppArray(ubo, "float")});
    same(scratch._aabb, ${cppArray(scratch._aabb)});
    close(actual._near, ${cppArray(expected._near)});
    close(actual._far, ${cppArray(expected._far)});
    close(actual._viewFrustumZ, ${cppArray(expected._viewFrustumZ)});
    close(actual._frustumLengths, ${cppArray(expected._frustumLengths)});
    ${fitted}
    ${index === 0 ? `changed::CsmCascadeScratch edited_scratch(4);
    const changed::CsmConfig edited_cfg{cfg._numCascades, cfg._lambda, cfg._cascadeBlendPercentage,
        cfg._stabilizeCascades, cfg._shadowMaxZ, cfg._bias, cfg._worldSpaceBias,
        cfg._darkness, cfg._frustumEdgeFalloff, cfg._mapSize, cfg._forceRefreshEveryFrame};
    const auto& edited = changed::csm_compute_cascades(${cppNumber(aspect)}, camera, light,
        edited_cfg, inputs, edited_scratch, [&](const Camera&, double) { return projection; });
    assert(edited._viewFrustumZ[0] == actual._viewFrustumZ[0] + 0.125);` : ""}
}`);
    }
    for (const scale of [0, 1e-10, 1e-10 - Number.EPSILON * 1e-10, 1, -0.125]) {
        const input = Float64Array.of(scale, 0, 0, 0, 0, 1.25, 0, 0, 0, 0, 0.75, 0,
            1000000.0001220703, 0.000000000125, -0.75, 1);
        const expected = new Float32Array(16);
        mat4InvertToRefOrIdentity(input, expected);
        cases.push(`{
    std::array<float, 16> inverse{};
    mat4_invert_to_ref_or_identity(${cppArray(input)}, inverse);
    same(inverse, ${cppArray(expected, "float")});
}`);
    }
    for (const scale of [0, 1e-12, 1e-9, 1.0000001e-9, 1]) {
        const mesh = casters()[0]!;
        const instance = new Float32Array(16);
        instance[0] = scale;
        instance[15] = 1;
        mesh.thinInstances = { matrices: instance, count: 1, _version: 1 };
        const expected = pin._castersWorldAabbInto([mesh], pin._createCascadeScratch(1));
        cases.push(`assert(csm_instance_contributes(${cppArray(instance, "float")}) == ${expected});`);
    }
    const point: [number, number, number] = [1000000.0001220703, -3.125, 0.000244140625];
    const matrix = Float32Array.of(1, 0.1, 0, 0, -0.2, 1.5, 0, 0, 0, 0, 0.875, 0, -1000000, 0, 0, 1);
    const transformed = [...point];
    pin.transformCoordInto(transformed, matrix, ...point);
    cases.push(`{
    auto point = ${cppArray(point)};
    csm_transform_coord_into(point, ${cppArray(matrix, "float")}, point[0], point[1], point[2]);
    same(point, ${cppArray(transformed)});
}`);
    const output = resolve("artifacts\\pinned-csm-check");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "csm_math.hpp"), pinnedCsmFunctions(context));
    writeFileSync(join(output, "csm_changed.hpp"), pinnedCsmFunctions(new ChangedCsmContext((source) => source
        .replace("const d = cfg._lambda * (log - uniform) + uniform;",
            "const d = cfg._lambda * (log - uniform) + uniform + 0.125;"))));
    const fixture = join(output, "check.cpp");
    writeFileSync(fixture, `#include <algorithm>
#include <array>
#include <bit>
#include <cassert>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <limits>
#include <optional>
#include <span>
#include <stdexcept>
#include <vector>
#include <bblite/js_data.hpp>
struct FixtureCaster {
    std::array<double, 16> world{};
    std::array<float, 16> instance{};
    bool has_instance = false;
    std::array<float, 3> bounds_min{}, bounds_max{};
};
namespace bbl::upstream {
using ShadowCaster = ::FixtureCaster;
inline constexpr std::size_t csm_max_cascades = 4;
#define near
#define far
#include "csm_math.hpp"
}
namespace changed {
using ShadowCaster = ::FixtureCaster;
inline constexpr std::size_t csm_max_cascades = 4;
#include "csm_changed.hpp"
}
#undef near
#undef far
using namespace bbl::upstream;
struct Camera { double near_plane, far_plane; };
struct Vector { double x, y, z; };
struct Light { Vector direction; };
int case_number = -1;
template <typename Actual, typename Expected>
void same(const Actual& actual, const Expected& expected) {
    assert(actual.size() == expected.size());
    for (std::size_t i = 0; i < actual.size(); ++i) {
        const auto a = actual[i], e = expected[i];
        const bool equal = std::isnan(e) ? std::isnan(a)
            : a == e && std::signbit(a) == std::signbit(e);
        if (!equal) { std::cerr << "case " << case_number << " lane " << i << ": " << a << " != " << e << "\\n"; std::abort(); }
    }
}
template <typename Actual, typename Expected>
void close(const Actual& actual, const Expected& expected) {
    assert(actual.size() == expected.size());
    for (std::size_t i = 0; i < actual.size(); ++i)
        assert(std::isnan(expected[i]) ? std::isnan(actual[i])
            : actual[i] == expected[i] || std::abs(actual[i] - expected[i]) <= 1e-12 * std::max(1.0, std::abs(expected[i])));
}
int main() {
    for (const std::size_t count : {std::size_t{0}, csm_max_cascades}) {
        CsmCascadeScratch scratch(count);
        assert(scratch._cascades._transforms.size() == count);
        assert(scratch._cascades._near.size() == count);
    }
    for (const std::size_t count : {csm_max_cascades + 1, std::numeric_limits<std::size_t>::max()}) {
        bool refused = false;
        try { CsmCascadeScratch scratch(count); }
        catch (const std::runtime_error&) { refused = true; }
        assert(refused);
    }
${cases.join("\n")}
    std::cout << "pinned-csm-check: ok\\n";
}
`);
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(nativeTools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD", "/fp:strict",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native\\include", fixture,
    ]);
    assert.match(execFileSync(executable, { encoding: "utf8" }), /pinned-csm-check: ok/);
});

test("CSM full shadow header compiles and publishes pinned receiver bytes", {
    skip: !nativeTools,
}, async () => {
    const pin = await importPinnedModule<Pick<PinCsm, "_writeCsmUbo">>("shadow/csm-shadow-task-hooks.js");
    const matrices = [
        Float32Array.from({ length: 16 }, (_, index) => (index - 8) / 16),
        Float32Array.from({ length: 16 }, (_, index) => (index + 1) / 32),
    ];
    const splitZ = [16777217, 100.000000000125];
    const lengths = [1.000000000125, -0];
    const config: PinConfig = {
        _numCascades: 2, _lambda: 0.5, _cascadeBlendPercentage: 0.1,
        _stabilizeCascades: false, _shadowMaxZ: null, _bias: 0.00005,
        _worldSpaceBias: null, _darkness: 0.125, _frustumEdgeFalloff: 0.03125,
        _mapSize: 1024, _forceRefreshEveryFrame: false,
    };
    const expected = new Float32Array(80);
    pin._writeCsmUbo(expected, {
        _transforms: matrices, _views: [], _near: [], _far: [],
        _viewFrustumZ: splitZ, _frustumLengths: lengths,
    }, config);
    const output = resolve("artifacts\\pinned-csm-header-check");
    const rendererIncludes = join(output, "bblite", "upstream");
    mkdirSync(rendererIncludes, { recursive: true });
    writeFileSync(join(output, "shadow.hpp"), pinnedShadowHeader(context));
    // The shadow header composes a caster's local matrix through the
    // pinned TRS composition every generated tree emits.
    writeFileSync(
        join(rendererIncludes, "pinned_world_transform.hpp"),
        pinnedWorldTransformHeader(context),
    );
    // Declarations only: this fixture exercises the shadow header's own
    // receiver adapter, not the separate renderer's camera/world routines.
    writeFileSync(join(rendererIncludes, "renderer_plan.hpp"), `#pragma once
namespace bbl::upstream {
std::array<float, 16> mesh_world_matrix(const Engine&, const MeshRecord&);
std::array<double, 16> apply_mesh_outer_transform(const MeshRecord&, const std::array<double, 16>&);
std::array<float, 16> build_view_projection(const CameraRecord&, double);
}
`);
    const fixture = join(output, "check.cpp");
    writeFileSync(fixture, `#include "shadow.hpp"
#include <cassert>
#include <iostream>
int main() {
    bbl::ShadowGeneratorRecord generator;
    generator.csm_num_cascades = 2;
    generator.csm_cascade_blend_percentage = 0.1;
    generator.map_size = 1024;
    generator.darkness = 0.125;
    generator.frustum_edge_falloff = 0.03125;
    generator.csm_cascades.resize(2);
${matrices.map((matrix, index) => `    generator.csm_cascades[${index}].transform = ${cppArray(matrix, "float")};
    generator.csm_cascades[${index}].view_frustum_z = ${cppNumber(splitZ[index]!)};
    generator.csm_cascades[${index}].frustum_length = ${cppNumber(lengths[index]!)};`).join("\n")}
    const auto block = bbl::upstream::csm_info_block(generator);
    const auto actual = std::bit_cast<std::array<float, 80>>(block);
    const auto expected = ${cppArray(expected, "float")};
    for (std::size_t i = 0; i < expected.size(); ++i)
        assert(std::bit_cast<std::uint32_t>(actual[i]) == std::bit_cast<std::uint32_t>(expected[i]));
    std::cout << "pinned-csm-header-check: ok\\n";
}
`);
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(nativeTools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD", "/fp:strict",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", output, "/I", "native\\include", fixture,
    ]);
    assert.match(execFileSync(executable, { encoding: "utf8" }), /pinned-csm-header-check: ok/);
});
