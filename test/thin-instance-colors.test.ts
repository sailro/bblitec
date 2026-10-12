import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import {
    lowerThinInstanceApi,
    lowerThinInstanceOwnership,
} from "../src/lowering/thin-instance-lowerer.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const native = optionalNativeFixtureTools(false);

test(
    "shared thin-pool release follows pinned implicit ownership",
    { skip: !native },
    async () => {
        interface Resource {
            _refCount?: number;
        }
        const { retain, release } = await importPinnedModule<{
            retain(this: void, resource: Resource): void;
            release(this: void, resource: Resource): boolean;
        }>("resource/ref-count.js");
        const resource: Resource = {};
        const freshRelease = release(resource);
        retain(resource);
        const retainedCount = resource._refCount;
        const sharedRelease = release(resource),
            singleCount = resource._refCount;
        const finalRelease = release(resource);
        runGeneratedProgram(
            native!,
            "thin-pool-ownership",
            `#include <bblite/runtime.hpp>
#include <cassert>
namespace bbl { ${lowerThinInstanceOwnership(new LoweringContext())} }
int main() {
    auto pool = std::make_shared<bbl::ThinInstancePoolData>();
    assert(bbl::release_thin_instance_pool(pool) == ${freshRelease});
    bbl::retain_thin_instance_pool(pool);
    auto clone = pool;
    assert(pool->ref_count.value() == ${retainedCount});
    assert(bbl::release_thin_instance_pool(pool) == ${sharedRelease});
    pool.reset();
    assert(clone->ref_count.value() == ${singleCount});
    assert(bbl::release_thin_instance_pool(clone) == ${finalRelease});
}`,
        );
    },
);

test(
    "thin-instance matrices retain arrays passed through a record and local scope",
    { skip: !native },
    () => {
        const result = compileSource(`
        import {createEngine, createBox, setThinInstances} from "@babylonjs/lite";
        const engine = await createEngine(document.createElement("canvas"));
        const mesh = createBox(engine);
        const gate = new Float32Array([1]);
        if (gate[0]) {
            const storage = {matrices: new Float32Array(16)};
            setThinInstances(mesh, storage.matrices, 1);
        }
    `);
        assert.match(result.cpp, /bbl::set_thin_instances\(/);
        const lowered = lowerThinInstanceApi(new LoweringContext(), [
            "mesh:thin-instances",
        ]);
        const functions = [
            "void set_thin_instances(Engine&",
            "ThinInstanceMatrices thin_instance_matrices(",
        ]
            .map((signature) =>
                cppFunction(lowered.replaceAll("\r\n", "\n"), signature),
            )
            .join("\n");
        runGeneratedProgram(
            native!,
            "thin-instance-matrix-lifetime",
            `#include <bblite/runtime.hpp>
#include <bblite/thin_instance.hpp>
#include <cassert>
namespace bbl { ${functions} }
template<class Values> void check() {
    bbl::Engine engine; engine.meshes.emplace_back();
    std::weak_ptr<std::vector<typename Values::value_type>> lifetime;
    {
        Values matrices(16); matrices[12] = 7;
        lifetime = matrices.storage();
        bbl::set_thin_instances(engine, {0}, matrices, 1);
    }
    assert(!lifetime.expired());
    auto alias = std::get<Values>(bbl::thin_instance_matrices(engine, {0}));
    alias[12] = static_cast<typename Values::value_type>(9.125);
    assert(bbl::thin_instance_matrix_values(*engine.meshes[0].thin_instances).load(12) == 9.125);
    engine.meshes[0].thin_instances.reset();
    assert(!lifetime.expired());
    alias = Values{};
    assert(lifetime.expired());
}
int main() {
    check<bbl::js::F32Array>(); check<bbl::js::F64Array>();
}`,
        );
    },
);

test(
    "thin-instance color writes retain owned buffers and offset views with pinned rounding",
    { skip: !native },
    async () => {
        const pinned = await importPinnedModule<{
            setThinInstanceColors(
                this: void,
                mesh: unknown,
                colors: Float32Array,
            ): void;
            setThinInstanceColor(
                this: void,
                mesh: unknown,
                index: number,
                r: number,
                g: number,
                b: number,
                a: number,
            ): void;
            setThinInstanceCullBoundsPad(
                this: void,
                mesh: unknown,
                pad: number,
            ): void;
        }>("mesh/thin-instance.js");
        const colors = new Float32Array(new ArrayBuffer(48), 8, 8);
        const mesh = {
            thinInstances: {
                count: 2,
                _version: 0,
                _colorVersion: 0,
                _colorDirtyMin: 0,
                _colorDirtyMax: 0,
                _cullBoundsPad: 0,
            },
        };
        pinned.setThinInstanceColors(mesh, colors);
        pinned.setThinInstanceColor(mesh, 1, 0.1, 0.2, 0.3, 0.4);
        pinned.setThinInstanceColor(mesh, -0.25, 1, 2, 3, 4);
        pinned.setThinInstanceColor(mesh, NaN, 5, 6, 7, 8);
        pinned.setThinInstanceCullBoundsPad(mesh, 2.5);
        const lowered = lowerThinInstanceApi(new LoweringContext(), [
            "mesh:thin-instances",
            "mesh:thin-instance-colors",
        ]);
        const functions = [
            "set_thin_instance_colors",
            "set_thin_instance_color",
            "set_thin_instance_cull_bounds_pad",
        ]
            .map((name) => cppFunction(lowered, `void ${name}(`))
            .join("\n");
        runGeneratedProgram(
            native!,
            "thin-instance-colors",
            `#include <bblite/runtime.hpp>
#include <bblite/thin_instance.hpp>
#include <bblite/js_data.hpp>
#include <cassert>
namespace bbl {
${functions}
}
int main() {
    for (bool view : {false, true}) {
        bbl::Engine engine;
        engine.meshes.emplace_back();
        engine.meshes[0].thin_instances = std::make_shared<bbl::ThinInstancePoolData>();
        auto& pool = *engine.meshes[0].thin_instances;
        pool.count = 2;
        bbl::js::ArrayBuffer buffer(std::make_shared<std::vector<std::uint8_t>>(48));
        bbl::js::F32Array colors = view ? bbl::js::F32Array(buffer, 8, 8) : bbl::js::F32Array(8);
        bbl::set_thin_instance_colors(engine, {0}, colors);
        bbl::set_thin_instance_color(engine, {0}, 1, .1, .2, .3, .4);
        bbl::set_thin_instance_color(engine, {0}, -.25, 1, 2, 3, 4);
        bbl::set_thin_instance_color(engine, {0}, std::numeric_limits<double>::quiet_NaN(), 5, 6, 7, 8);
        bbl::set_thin_instance_cull_bounds_pad(engine, {0}, 2.5);
        const std::array<double, 8> expected{${Array.from(colors).join(",")}};
        for (std::size_t lane = 0; lane < expected.size(); ++lane) {
            assert(colors.load(lane) == expected[lane]);
            assert(pool.colors.value().load(lane) == expected[lane]);
        }
        assert(pool.version == ${mesh.thinInstances._version});
        assert(pool.color_version == ${mesh.thinInstances._colorVersion});
        assert(std::isnan(pool.color_dirty_min) && std::isnan(pool.color_dirty_max));
        assert(pool.cull_bounds_pad == ${mesh.thinInstances._cullBoundsPad});
    }
}`,
        );
        const result = compileSource(`
        import { createEngine, createBox, setThinInstances, setThinInstanceColors, setThinInstanceColor,
            setThinInstanceCullBoundsPad } from "@babylonjs/lite";
        const engine = createEngine(document.createElement("canvas"));
        const mesh = createBox(engine);
        setThinInstances(mesh, new Float32Array(16), 1);
        setThinInstanceColors(mesh, new Float32Array(4));
        setThinInstanceColor(mesh, 0, 1, .5, .25, 1);
        setThinInstanceCullBoundsPad(mesh, 2);
    `);
        assert.match(result.cpp, /bbl::set_thin_instance_color\(/);
        assert.match(result.cpp, /bbl::set_thin_instance_cull_bounds_pad\(/);
    },
);
