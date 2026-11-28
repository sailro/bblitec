/**
 * An optional material stored through an asserted view into a mesh's
 * required material slot: the material where present, and the TypeError a
 * read through an absent value throws where not.
 */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("an asserted optional material stored as a mesh's material throws where absent", (t) => {
    const { cpp } = compileSource(
        `
        import { createBox, type EngineContext, type ShaderMaterial } from "@babylonjs/lite";
        interface Assets { flat?: ShaderMaterial }
        function apply(engine: EngineContext, assets: Assets): number {
            const mesh = createBox(engine);
            (mesh as unknown as { material: unknown }).material = assets.flat;
            return 1;
        }
        const appliers: Array<typeof apply> = [apply];
        void appliers;
    `,
        { fileName: resolve("asserted-material-slot.ts") },
    );
    const entry =
        /double (\w+)\(\[\[maybe_unused\]\] bblscene::(\w+)& \w+, \[\[maybe_unused\]\] bbl::StoredEngine \w+, \[\[maybe_unused\]\] bblscene::Assets \w+\);/.exec(
            cpp,
        );
    assert.ok(entry, "material-storing callback");
    assert.match(
        cpp,
        /bbl::set_mesh_material\([^;]*bbl::js::present\(v_fn\d+_assets->flat\)\);/,
    );
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(
        native,
        "asserted-material-slot",
        `
        #define main generated_main
        ${cpp}
        #undef main
        #include <cassert>
        #include <cstdio>
        namespace bbl {
            MeshHandle create_box(Engine& engine, BoxOptions) {
                engine.meshes.emplace_back();
                return {static_cast<std::uint32_t>(engine.meshes.size() - 1), 0};
            }
            std::uint32_t assigned = 0;
            void set_mesh_material(Engine&, MeshHandle, MaterialHandle material) { assigned = material.value; }
        }
        int main() {
            const bbl::js::RealmScope realm;
            auto engine = std::make_shared<bbl::Engine>();
            bblscene::${entry[2]} environment{};
            auto present = bbl::js::make_ref<bblscene::AssetsData>();
            present->flat = bbl::MaterialHandle{7};
            assert(bblscene::${entry[1]}(environment, bbl::StoredEngine{engine}, present) == 1);
            assert(bbl::assigned == 7);
            try {
                bblscene::${entry[1]}(environment, bbl::StoredEngine{engine}, bbl::js::make_ref<bblscene::AssetsData>());
                return 1;
            } catch (const bbl::js::NamedError& error) {
                std::printf("%s", error.name.c_str());
            }
        }
    `,
        { expectedOutput: "TypeError" },
    );
});
