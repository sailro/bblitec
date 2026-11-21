import assert from "node:assert/strict";
import test from "node:test";
import { doubleLiteral, floatLiteral } from "../src/cpp-literals.js";
import { LoweringContext } from "../src/lowering/context.js";
import { pinnedShadowHeader } from "../src/lowering/shadow-lowerer.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import {
    cppFunction,
    cppRecord,
    optionalNativeFixtureTools,
    runGeneratedProgram,
    sharedGpuSource,
} from "./native-fixture.js";

test("single-map directional fit follows the pin across thin-pool mutations", async (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native compiler unavailable.");
    const identity = Float64Array.of(
        1,
        0,
        0,
        0,
        0,
        1,
        0,
        0,
        0,
        0,
        1,
        0,
        0,
        0,
        0,
        1,
    );
    const world = Float64Array.of(
        1,
        0.125,
        0,
        0,
        0.25,
        -1,
        0.25,
        0,
        0.5,
        0,
        1,
        0,
        1000000.125,
        4,
        5,
        1,
    );
    const mesh: {
        worldMatrix: Float64Array;
        worldMatrixVersion: number;
        boundMin: number[];
        thinInstances?: {
            matrices: Float64Array;
            count: number;
            _version: number;
        };
    } = {
        worldMatrix: world,
        worldMatrixVersion: 1,
        boundMin: [-1.5, -1, -0.25],
    };
    const light = { direction: { x: -1, y: -2, z: 1 }, worldMatrix: identity };
    const pin = await importPinnedModule<{
        preloadDirectionalShadowBounds(
            meshes: readonly (typeof mesh)[],
        ): Promise<void>;
        computeDirectionalLightMatrix(
            sourceLight: typeof light,
            meshes: readonly (typeof mesh)[],
            near: number,
            far: number,
            x: number,
            y: number,
            z: number,
        ): { _viewProj: Float32Array };
    }>("shadow/shadow-base.js");
    const cases: string[] = [];
    function check(cpp: string) {
        const expected = pin.computeDirectionalLightMatrix(
            light,
            [mesh],
            -10,
            30,
            1000000,
            0,
            0,
        )._viewProj;
        cases.push(
            `${cpp}\ncheck(std::array<float,16>{${Array.from(expected, floatLiteral).join(",")}});`,
        );
    }
    check("");
    const matrices = new Float64Array(48);
    matrices.set(identity, 0);
    matrices[12] = 10.000000000125;
    matrices.set(identity, 16);
    matrices[28] = -21.125;
    // The third row is parked, even though it has a distant translation.
    matrices[44] = 9000;
    mesh.thinInstances = { matrices, count: 8, _version: 0 };
    await pin.preloadDirectionalShadowBounds([mesh]);
    check(`auto pool = std::make_shared<ThinInstancePoolData>();
        mesh.thin_instances = pool;
        js::F64Array data(48);
        const std::array<double,48> values{${Array.from(matrices, doubleLiteral).join(",")}};
        for (std::size_t i=0;i<values.size();++i) data.store(i,values[i]);
        pool->matrices=data; pool->count=8;`);
    matrices[12] = 140;
    check("data.store(12,140);"); // Same live buffer and version: a cache hit.
    mesh.thinInstances._version++;
    check("++pool->version;");
    mesh.thinInstances.count = 0;
    check("pool->count=0;");
    mesh.thinInstances.count = 1.5;
    check("pool->count=1.5;");
    mesh.boundMin[0] = -3;
    check("mesh.bounds_min_override.x=-3;");
    mesh.thinInstances.matrices = matrices.slice();
    mesh.thinInstances.matrices[12] = -100;
    check(
        "js::F64Array replacement(48); for(std::size_t i=0;i<48;++i) replacement.store(i,data.load(i)); replacement.store(12,-100); pool->matrices=replacement;",
    );
    const header = pinnedShadowHeader(new LoweringContext());
    const constants = header.slice(
        header.indexOf(
            "inline constexpr std::array<float, 3> shadow_caster_bounds_fallback_min",
        ),
        header.indexOf("struct ShadowBoundsCache {"),
    );
    const result = runGeneratedProgram(
        tools,
        "directional-shadow-fit",
        `#include <bblite/runtime.hpp>
#include <cassert>
namespace bbl::upstream {
std::array<float,16> light_world_matrix(const LightRecord&) {return {${Array.from(identity).join(",")}};}
std::array<double,16> mesh_world_matrix_f64(const Engine&,const MeshRecord&) {return {${Array.from(world, doubleLiteral).join(",")}};}
${cppRecord(header, "struct ShadowCaster {")}
${cppRecord(header, "struct ShadowLightMatrix {")}
${constants}
${cppRecord(header, "struct ShadowBoundsCache {")}
${cppFunction(header, "inline bool fit_shadow_caster_world_bounds(")}
${cppFunction(header, "inline std::array<float, 16> build_light_view_matrix(")}
${cppFunction(header, "inline std::array<float, 16> shadow_light_view(")}
${cppFunction(header, "inline ShadowLightMatrix compute_directional_light_matrix(")}
}
namespace bbl::pal {
${cppFunction(sharedGpuSource(), "void fitted_shadow_casters(")}
}
int main() {
    using namespace bbl;
    Engine engine; engine.meshes.emplace_back();
    auto& mesh=engine.meshes.front(); mesh.transform_version=1;
    mesh.has_bounds_min_override=true; mesh.bounds_min_override={-1.5f,-1.f,-.25f};
    LightRecord light; light.direction={-1,-2,1};
    ShadowGeneratorRecord generator;
    generator.caster_meshes.push_back({0});
    std::vector<upstream::ShadowCaster> inputs;
    auto check=[&](const auto& expected) {
        for (auto filter:{ShadowFilter::esm_directional,ShadowFilter::pcf_directional}) {
            generator.filter=filter;
            pal::fitted_shadow_casters(engine,generator,inputs);
            const auto matrix=upstream::compute_directional_light_matrix(light,inputs,-10,30,{1000000,0,0});
            assert(matrix.view_projection==expected);
            assert(matrix.near_plane==-10 && matrix.far_plane==30);
        }
    };
    ${cases.join("\n")}
}`,
        {
            flags: [
                "/DBBLITE_SHADOW_MORPH_BOUNDS=0",
                "/DBBLITE_SHADOW_SKELETON_BOUNDS=0",
            ],
        },
    );
    assert.equal(result, "");
});
