import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { getScene, resolveScene, scenes } from "../src/scene-registry.js";
import {
    paritySceneTarget,
    validateReferenceCapture,
} from "../src/parity-scene.js";

test("states the curated scene and demo counts the registry actually holds", () => {
    // Keep one measured headline rather than repeating counts in the proof
    // points. Curated scenes are pinned `sceneNNN` corpus entries; demos are
    // the exact upstream application gates.
    const curated = scenes.filter(({ id }) =>
        /^scene\d+$/.test(id),
    ).length;
    const demos = scenes.filter(({ sourceOrigin }) =>
        sourceOrigin === "babylon-lite-application",
    ).length;
    const readme = readFileSync(resolve("README.md"), "utf8");
    const stated = /(\d+) curated parity scenes and (\d+) demos/.exec(
        readme,
    );
    assert.ok(stated, "README no longer states the curated scene and demo counts.");
    assert.equal(Number(stated[1]), curated);
    assert.equal(Number(stated[2]), demos);
    assert.equal([...readme.matchAll(/\d+ curated/g)].length, 1);
});

test("registers unique generated scene targets", () => {
    assert.deepEqual(
        scenes
            .filter(({ sourceOrigin }) =>
                sourceOrigin !== "babylon-lite-application",
            )
            .map(({ id }) => id),
        ["primitives", "scene1", "scene3", "scene6", "scene14", "scene24", "scene28", "scene29", "scene31", "scene33", "scene35", "scene216", "scene150", "scene178", "scene210", "scene212", "scene243", "scene246", "scene247", "scene252", "scene254", "scene255", "scene258", "scene259", "scene265", "scene2", "scene7", "scene8", "scene5", "scene10", "scene12", "scene13", "scene32", "scene159", "scene160", "scene161", "scene162", "scene163", "audit-shader-frame-graph", "regression-runtime-sweep", "regression-sprite-layer-arms", "regression-instanced-ground", "regression-morph-ground", "regression-light-setters", "regression-compiler-state", "scene168", "scene176", "scene213", "scene151", "scene154", "scene152", "scene157", "scene158", "scene155", "scene240", "scene250", "scene170", "scene175", "regression-track-clamp", "scene110", "scene120", "scene125", "scene126", "scene127", "scene128", "scene116", "scene145", "scene146", "scene248", "scene245", "scene249", "scene257", "scene266", "scene267", "scene268", "scene30", "scene256", "scene260", "scene34", "scene9", "scene242", "scene23", "scene40", "scene273", "scene274", "scene244", "scene37", "scene253", "scene38", "scene39", "scene21", "scene19", "scene15", "scene50", "scene56", "scene57", "scene92", "scene93", "scene94", "scene95", "scene96", "scene97", "scene54", "scene55", "scene98", "scene177", "regression-animation-groups", "scene26", "scene27", "scene142", "scene143", "scene147", "scene11", "scene148", "scene60", "scene61", "scene77", "scene78", "scene79", "scene80", "scene82", "scene85", "scene88", "scene89", "scene63", "scene67", "scene68", "scene69", "scene70", "scene71", "scene84", "scene62", "scene81", "scene87", "scene74", "scene75", "scene76", "scene262", "scene263", "scene264", "scene276", "scene277", "scene280", "scene281", "scene283", "scene284", "scene278", "scene279", "scene301", "scene282", "scene220", "scene25", "scene36", "scene251", "scene18", "scene4", "scene203", "scene205", "scene204", "scene206", "scene207", "scene202", "scene65", "scene141", "scene22", "regression-gltf-sparse", "regression-gltf-uv-sets", "regression-gltf-topology", "regression-gltf-step-animation", "regression-shadow-esm-only", "regression-shadow-pbr-only", "scene144", "scene217"]
    );
    assert.deepEqual(
        scenes
            .filter(({ sourceOrigin }) =>
                sourceOrigin === "babylon-lite-application",
            )
            .map(({ id }) => id),
        ["tetris", "doom", "torus-states"],
    );
    assert.equal(new Set(scenes.map(({ output }) => output)).size, scenes.length);
    // Entries carry only what is theirs; every path a scene id implies is
    // derived, so the registry cannot restate one of them incorrectly.
    for (const scene of scenes) {
        if (scene.id === "primitives") continue;
        assert.equal(scene.output, `generated/${scene.id}`);
        assert.equal(
            scene.buildDirectory,
            `native/build-${scene.id}-release`,
        );
        if (!scene.parity) continue;
        assert.equal(
            scene.parity.reference.path,
            `reference/${scene.id}/babylon-lite-golden.png`,
        );
        assert.equal(
            scene.parity.outputDirectory,
            `artifacts/parity/${scene.id}`,
        );
    }
    // An entry that needs a different target still gets it.
    assert.equal(
        getScene("primitives").buildDirectory,
        "native/build-sdl",
    );
    assert.equal(
        getScene("primitives").output,
        "generated/primitives",
    );
    assert.equal(getScene("scene10").parity?.reference.kind, "source");
    assert.equal(getScene("scene2").parity?.maxFullMad, 0.01);
    assert.equal(getScene("scene163").parity?.maxFullMad, 0.001);
    assert.equal(
        getScene("audit-shader-frame-graph").parity?.maxFullMad,
        0.001,
    );
    assert.equal(
        getScene("audit-shader-frame-graph").sourceOrigin,
        "bblitec-regression",
    );
    assert.equal(
        getScene("regression-track-clamp").sourceOrigin,
        "bblitec-regression",
    );
    assert.equal(
        getScene("regression-compiler-state").sourceOrigin,
        "bblitec-regression",
    );
    assert.equal(getScene("scene8").parity?.maxFullMad, 0.2);
    assert.equal(getScene("scene176").parity?.reference.kind, "source");
    assert.equal(getScene("scene213").parity?.reference.kind, "source");
    assert.equal(
        getScene("scene273").parity?.nativeEnvironment?.BBLITE_SCREENSHOT_FRAME,
        "19",
    );
    assert.equal(getScene("scene273").parity?.maxFullMad, 0.001);
    assert.equal(getScene("scene1").parity?.reference.kind, "source");
    assert.throws(() => getScene("missing"), /Unknown scene/);
});

test("spells the measured pose once: the native seek derives from referenceTimeSeconds", () => {
    // 23 entries used to hand-pair referenceTimeSeconds with
    // nativeEnvironment.BBLITE_ANIMATION_SEEK_SECONDS; drift would have
    // split rung 1 (the env var, read by the parity run) from rung 3
    // (referenceTimeSeconds, read by capture --native and diff)
    // silently. The registry now derives the env var, and this asserts
    // the pairing holds for every entry in both directions.
    let derived = 0;
    for (const scene of scenes) {
        const pose = scene.parity?.referenceTimeSeconds;
        const seek =
            scene.parity?.nativeEnvironment
                ?.BBLITE_ANIMATION_SEEK_SECONDS;
        if (pose === undefined) {
            assert.equal(
                seek,
                undefined,
                `${scene.id} carries a native seek with no referenceTimeSeconds.`,
            );
            continue;
        }
        assert.ok(
            seek !== undefined,
            `${scene.id} pins referenceTimeSeconds=${pose} but derives no native seek.`,
        );
        assert.equal(
            Number(seek),
            pose,
            `${scene.id}: BBLITE_ANIMATION_SEEK_SECONDS='${seek}' disagrees with referenceTimeSeconds=${pose}.`,
        );
        derived += 1;
    }
    // The derivation is live, not vacuous: the registry holds animated
    // scenes.
    assert.ok(derived >= 20, `only ${derived} scenes derive a seek.`);
});

test("derives defaults for an unregistered scene source", () => {
    const source = ".cache/adhoc-scene.ts";
    mkdirSync(".cache", { recursive: true });
    writeFileSync(source, "export {};\n");
    try {
        const scene = resolveScene(source);
        assert.equal(scene.id, "adhoc-scene");
        assert.equal(scene.output, "generated/adhoc-scene");
        assert.equal(scene.buildDirectory, "native/build-adhoc-scene-release");
        assert.equal(
            scene.parity?.reference.path,
            "reference/adhoc-scene/babylon-lite-golden.png",
        );
        assert.equal(scene.parity?.maxFullMad, undefined);
        assert.deepEqual(scene.parity?.nativeEnvironment, {
            BBLITE_FRAME_DELTA_MS: String(1000 / 60),
            BBLITE_SCREENSHOT_FRAME: "180",
        });
        assert.equal(paritySceneTarget(scene), source);
    } finally {
        rmSync(source, { force: true });
    }
});

test("resolves a registered scene by source path", () => {
    const scene = resolveScene(
        "corpus/babylon-lite/lab/lite/src/lite/scene10.ts",
    );
    assert.equal(scene.id, "scene10");
    assert.equal(paritySceneTarget(scene), "scene10");
});

test("rejects ad-hoc sources that collide with registered scene ids", () => {
    const source = ".cache/scene10.ts";
    mkdirSync(".cache", { recursive: true });
    writeFileSync(source, "export {};\n");
    try {
        assert.throws(
            () => resolveScene(source),
            /derives registered scene id 'scene10'/,
        );
    } finally {
        rmSync(source, { force: true });
    }
});

test("requires explicit recapture for missing curated references", () => {
    const scene = getScene("scene10");
    const missing = resolve(
        ".cache",
        "missing-curated-reference.png",
    );
    assert.throws(
        () => validateReferenceCapture(scene, missing, false),
        /Curated reference is missing/,
    );
    assert.doesNotThrow(
        () => validateReferenceCapture(scene, missing, true),
    );

    const source = ".cache/reference-policy-adhoc.ts";
    mkdirSync(".cache", { recursive: true });
    writeFileSync(source, "export {};\n");
    try {
        const adHoc = resolveScene(source);
        assert.doesNotThrow(
            () => validateReferenceCapture(adHoc, missing, false),
        );
    } finally {
        rmSync(source, { force: true });
    }
});

test("keeps package scene commands registry-driven", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
        scripts: Record<string, string>;
    };
    const scriptNames = Object.keys(packageJson.scripts);
    assert.deepEqual(
        scriptNames.filter((name) => /^(?:compile|parity):scene\d+$/.test(name)),
        [],
    );
    assert.equal(packageJson.scripts["scenes:compile"], "npm run scene -- compile all");
    assert.equal(packageJson.scripts["scenes:build"], "npm run scene -- build all");
    assert.equal(packageJson.scripts["scenes:process"], "npm run scene -- process all");
    assert.equal(packageJson.scripts.doctor, "npm run scene -- doctor");
    assert.equal(packageJson.scripts["dev:setup"], "npm run scene -- setup");
    assert.equal(packageJson.scripts.sweep, "npm run scene -- validate all");
    // Both published columns are measured every run: the table carries an
    // SDL_GPU and a Dawn number per scene, and a single-backend sweep
    // leaves the second one unverified between manual differential runs.
    assert.equal(
        packageJson.scripts["scenes:parity"],
        "npm run scene -- parity all --differential",
    );
    assert.equal(
        packageJson.scripts["status:verify"],
        "npm run build && node dist/src/verify-status.js",
    );
    const sceneCommand = readFileSync("src/scene-command.ts", "utf8");
    assert.match(
        sceneCommand,
        /process\.env\.BBLITE_CMAKE_GENERATOR \?\? "Ninja"/,
    );
    assert.match(sceneCommand, /discoverWindowsBuildTools/);
    assert.match(sceneCommand, /runGeometryOutputDiagnostics/);
    assert.match(
        sceneCommand,
        /`-DBBLITE_DAWN_DIR=\$\{tools\.dawnDirectory\}`/,
    );
    const parityScene = readFileSync("src/parity-scene.ts", "utf8");
    assert.match(parityScene, /windowsHide: true/);
    assert.match(parityScene, /BBLITE_TEST_PASS: "1"/);
});
