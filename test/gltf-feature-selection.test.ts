import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { joinAssetFeatures } from "../src/asset-feature-join.js";
import { emitAssetSpecializations } from "../src/asset-specializer.js";
import { compileSource } from "../src/compiler.js";
import { readAssetBytesSync } from "../src/compiler/asset-bytes-sync.js";
import { gltfDocumentFromBytes } from "../src/gltf-document.js";
import { pinnedGltfThinInstanceSelection } from "../src/pinned-gltf-feature-selection.js";
import { doctoredContext } from "./doctored-store.js";
import { buildGlb } from "./glb-fixture.js";

const extension = "EXT_mesh_gpu_instancing";
const instanced = { asset: { version: "2.0" }, extensionsUsed: [extension] };
const program = (url: string) => `
    import {createEngine, loadGltf} from "@babylonjs/lite";
    async function main() {
        const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
        const engine = await createEngine(canvas);
        await loadGltf(engine, ${JSON.stringify(url)});
    }
    void main();
`;

test("early glTF selection uses the source registry trigger, including GLB input", () => {
    const selected = pinnedGltfThinInstanceSelection();
    assert.equal(selected(instanced), true);
    const binary = gltfDocumentFromBytes(buildGlb(instanced));
    assert.ok(binary);
    assert.equal(selected(binary), true);
    assert.equal(selected({}), false);
    assert.equal(selected({ extensionsUsed: ["KHR_materials_unlit"] }), false);
    assert.equal(selected({ extensionsRequired: [extension] }), false);
    assert.equal(
        selected({
            nodes: [{ extensions: { [extension]: { attributes: {} } } }],
        }),
        false,
    );
});

test("early glTF selection executes changes in both source discovery gates", () => {
    const changedTrigger = pinnedGltfThinInstanceSelection(
        doctoredContext(
            "src/loader-gltf/gltf-feature-registry.ts",
            '["EXT_mesh_gpu_instancing", () => import',
            '["test_instancing", () => import',
        ),
    );
    assert.equal(changedTrigger(instanced), false);
    assert.equal(changedTrigger({ extensionsUsed: ["test_instancing"] }), true);
    const changedRegistry = pinnedGltfThinInstanceSelection(
        doctoredContext(
            "src/loader-gltf/gltf-feature-registry.ts",
            "const used: string[] = json.extensionsUsed ?? [];",
            "const used: string[] = json.extensionsRequired ?? [];",
        ),
    );
    assert.equal(changedRegistry(instanced), false);
    assert.equal(
        changedRegistry({ ...instanced, extensionsRequired: [extension] }),
        true,
    );
    const changedLoader = pinnedGltfThinInstanceSelection(
        doctoredContext(
            "src/loader-gltf/load-gltf.ts",
            "json.extensionsUsed?.length ||",
            "false ||",
        ),
    );
    assert.equal(changedLoader(instanced), false);
});

test("generation reads canonical local assets before choosing the application realm", () => {
    const directory = mkdtempSync(join(tmpdir(), "bblite-gltf-selection-"));
    try {
        writeFileSync(join(directory, "model.glb"), buildGlb(instanced));
        const result = compileSource(program("model.glb"), {
            fileName: join(directory, "main.ts"),
            readAssetBytes: readAssetBytesSync,
        });
        assert.ok(result.manifest.features.includes("mesh:thin-instances"));
        assert.ok(result.manifest.features.includes("engine:gpu-retirement"));
        assert.doesNotMatch(result.cpp, /bbl::pal::create_realm_engine/);
        assert.ok(!result.manifest.features.includes("platform:workers"));
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("plain glTF and compile-only placeholders do not activate thin instances", () => {
    const url =
        "data:model/gltf+json;base64," +
        Buffer.from(JSON.stringify({ asset: { version: "2.0" } })).toString(
            "base64",
        );
    const plain = compileSource(program(url), {
        readAssetBytes: readAssetBytesSync,
    });
    const placeholder = compileSource(
        program("https://example.test/model.glb"),
    );
    for (const result of [plain, placeholder]) {
        assert.ok(!result.manifest.features.includes("mesh:thin-instances"));
        assert.ok(!result.manifest.features.includes("engine:gpu-retirement"));
        assert.doesNotMatch(result.cpp, /bbl::pal::create_realm_engine/);
    }
});

test("late packaged instancing refuses entry compilation without resource facts", async () => {
    const result = compileSource(program("model.glb"));
    const specialization = emitAssetSpecializations("", [], new Map());
    await assert.rejects(
        joinAssetFeatures({
            result,
            outputPath: "",
            documents: new Map(),
            specialization: { ...specialization, gpuInstancing: true },
            splatHarmonics: undefined,
        }),
        /without entry-time asset discovery/,
    );
});
