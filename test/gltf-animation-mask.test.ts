import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { specializeGltf } from "../src/asset-specializer.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeGlbFixture } from "./glb-fixture.js";

/** The reached shape: a loaded file's groups, masked and slowed. */
function maskScene(body: string): string {
    return `
        import {
            addToScene,
            AnimationGroupMaskMode,
            createAnimationGroupMask,
            createArcRotateCamera,
            createEngine,
            createHemisphericLight,
            createSceneContext,
            loadGltf,
            registerScene,
            startEngine,
        } from "@babylonjs/lite";

        const BONES = ["mixamorig:LeftUpLeg", "mixamorig:LeftLeg"];

        async function main() {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const scene = createSceneContext(engine);
            scene.camera = createArcRotateCamera(0, 1, 3, { x: 0, y: 0, z: 0 });
            addToScene(scene, createHemisphericLight([0, 1, 0], 1));
            const asset = await loadGltf(engine, "https://playground.babylonjs.com/scenes/Xbot.glb");
            addToScene(scene, asset);
            const groups = asset.animationGroups ?? [];
            ${body}
            await registerScene(scene);
            await startEngine(engine);
        }

        main().catch(console.error);
    `;
}

test("lowers a glTF group's mask, in either mode", () => {
    const excluded = compileSource(
        maskScene(`
            for (const group of groups) {
                group.mask = createAnimationGroupMask(
                    BONES,
                    AnimationGroupMaskMode.Exclude,
                );
            }
        `),
        { fileName: "examples/mask.ts" },
    );
    assert.ok(
        excluded.manifest.features.includes("animation:gltf-group-mask"),
    );
    assert.match(
        excluded.cpp,
        /bbl::set_animation_mask\([^;]*std::vector<std::string>\{"mixamorig:LeftUpLeg", "mixamorig:LeftLeg"\}, false\)/,
    );

    // The factory's own default is Include, so an omitted mode is `true`.
    const included = compileSource(
        maskScene(`
            for (const group of groups) {
                group.mask = createAnimationGroupMask(BONES);
            }
        `),
        { fileName: "examples/mask.ts" },
    );
    assert.match(
        included.cpp,
        /bbl::set_animation_mask\([^;]*\}, true\)/,
    );
});

test("refuses a mask this port cannot resolve at generation", () => {
    // A mode that is not one of the pin's two enum members.
    assert.throws(
        () =>
            compileSource(
                maskScene(`
                    for (const group of groups) {
                        group.mask = createAnimationGroupMask(BONES, 7);
                    }
                `),
                { fileName: "examples/mask.ts" },
            ),
        /Expected a member of the pinned AnimationGroupMaskMode enum/,
    );
    // A value that is not a mask at all.
    assert.throws(
        () =>
            compileSource(
                maskScene(`
                    for (const group of groups) {
                        group.mask = groups;
                    }
                `),
                { fileName: "examples/mask.ts" },
            ),
        /animation-group-mask/,
    );
});

test("lowers a glTF group's speed ratio", () => {
    const result = compileSource(
        maskScene(`
            for (const group of groups) {
                group.speedRatio = 0.5;
            }
        `),
        { fileName: "examples/speed.ts" },
    );
    assert.ok(
        result.manifest.features.includes("animation:gltf-group-speed"),
    );
    assert.match(
        result.cpp,
        /bbl::set_animation_speed_ratio\([^;]*0\.5f\)/,
    );
});

test("separates the point/line topologies from the triangle strip", () => {
    const directory = mkdtempSync(join(tmpdir(), "bblitec-topology-"));
    try {
        const path = join(directory, "asset.glb");
        const write = (document: Record<string, unknown>): void =>
            writeGlbFixture(path, { asset: { version: "2.0" }, ...document });
        const primitive = (mode: number): Record<string, unknown> => ({
            accessors: [{ count: 3 }],
            meshes: [
                {
                    primitives: [
                        { mode, attributes: { POSITION: 0 } },
                    ],
                },
            ],
        });

        // A triangle strip loads the lazy primitive feature upstream, but the
        // loader expands it into the triangle list it describes, so what ships
        // is a triangle list and no pipeline carries a topology for it.
        write(primitive(5));
        let features = specializeGltf(path, "asset.glb").features;
        assert.equal(features.nonTrianglePrimitives, true);
        assert.equal(features.pointOrLinePrimitives, false);

        for (const mode of [0, 1, 3]) {
            write(primitive(mode));
            features = specializeGltf(path, "asset.glb").features;
            assert.equal(features.nonTrianglePrimitives, true);
            assert.equal(features.pointOrLinePrimitives, true);
        }

        write(primitive(4));
        features = specializeGltf(path, "asset.glb").features;
        assert.equal(features.nonTrianglePrimitives, false);
        assert.equal(features.pointOrLinePrimitives, false);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
