import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { featureOrder } from "../src/compiler/output-projection.js";
import { isLibraryDescription } from "../src/library-description.js";
import { compileLibrary } from "../src/library-manifest.js";
import { resolveScene } from "../src/scene-registry.js";

const describe = (
    features: readonly string[],
    imageCodecs: readonly string[] = [],
): string => JSON.stringify({ features, imageCodecs });

test("a library description compiles to a program-less manifest in feature order", () => {
    const { manifest, cppFiles, cmake } = compileLibrary(
        describe(
            [
                "mesh:box",
                "renderer:scene",
                "light:point",
                "core",
                "material:standard",
            ],
            ["png"],
        ),
        "lite/library.json",
    );
    assert.deepEqual(
        manifest.features,
        featureOrder.filter((feature) => manifest.features.includes(feature)),
    );
    assert.equal(cppFiles.size, 0);
    assert.deepEqual(manifest.sourceUnits, []);
    assert.match(cmake, /set\(BBLITE_APPLICATION_SOURCES\n\n\)/);
    assert.deepEqual(manifest.sceneMeshes, [
        { kind: "procedural", gltfAssetsBefore: 0, standardMaterial: true },
    ]);
    assert.equal(manifest.sceneMaterialCount, 1);
    assert.equal(manifest.dynamicSceneLights, true);
    assert.deepEqual(manifest.imageCodecs, ["png"]);
    assert.equal(manifest.source, "lite/library.json");
});

test("a library closes its features over their implications", () => {
    const { manifest } = compileLibrary(
        describe(["core", "renderer:scene", "compute:one-shot"]),
        "lite/library.json",
    );
    assert.ok(manifest.features.includes("compute:task"));
});

test("a library records the adaptations its features alone decide", () => {
    const { manifest } = compileLibrary(
        describe(["core", "renderer:scene", "physics:world"]),
        "lite/library.json",
    );
    assert.ok(
        manifest.adaptations.some(
            ({ id }) => id === "substituted-physics-solver",
        ),
    );
});

test("a library without meshes or a Standard material records neither", () => {
    const { manifest } = compileLibrary(
        describe(["core", "renderer:scene"]),
        "lite/library.json",
    );
    assert.deepEqual(manifest.sceneMeshes, []);
    assert.equal(manifest.sceneMaterialCount, 0);
});

test("a library description refuses unknown names and malformed lists", () => {
    assert.throws(
        () => compileLibrary(describe(["core", "mesh:teapot"]), "x.json"),
        /Unknown runtime feature 'mesh:teapot'/,
    );
    assert.throws(
        () => compileLibrary(describe(["core"], ["tiff"]), "x.json"),
        /unknown image codec 'tiff'/,
    );
    assert.throws(
        () => compileLibrary(JSON.stringify({ features: "core" }), "x.json"),
        /lists its features as an array of names/,
    );
});

test("the checked-in library description resolves and compiles", () => {
    assert.equal(isLibraryDescription("lite/LIBRARY.JSON"), true);
    const scene = resolveScene("lite/library.json");
    assert.equal(scene.id, "library");
    assert.equal(scene.output, "generated/library");
    compileLibrary(readFileSync(scene.source, "utf8"), scene.source);
});
