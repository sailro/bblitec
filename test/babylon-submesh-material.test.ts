import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { lowerBabylonMeshConstruction } from "../src/lowering/babylon-mesh-construction.js";
import { lowerBabylonSubmeshDefaults } from "../src/lowering/babylon-submesh-indices.js";
import { importPinnedModuleFetching } from "../src/pinned-shader-composer.js";
import { runBabylonLoaderCheck } from "./babylon-loader-fixture.js";
import { doctoredContext } from "./doctored-store.js";
import { cppFunction, optionalNativeFixtureTools } from "./native-fixture.js";

test("Babylon submeshes select pinned materials and allocate independent fallback records", async (t) => {
    const native = optionalNativeFixtureTools();
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const cases = [
        ["one", [0, 5]],
        ["many", [0, 1, 2]],
        ["single", [5]],
        ["missing", [0, 1]],
        ["", [0, 0]],
        ["unknown", [0, 0]],
        ["empty", [0]],
    ] as const;
    const document = {
        materials: [
            { id: "one", alpha: 0.25 },
            { id: "two", alpha: 0.5 },
            { id: "many", alpha: 0.75 },
        ],
        multiMaterials: [
            { id: "many", materials: ["one", "two"] },
            { id: "single", materials: ["two"] },
            { id: "missing", materials: ["unknown"] },
            { id: "empty", materials: [] },
        ],
        meshes: cases.map(([materialId, indices], index) => ({
            id: String(index),
            name: String(index),
            materialId,
            positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
            normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
            indices: [0, 1, 2],
            subMeshes: indices.map((materialIndex) => ({
                materialIndex,
                verticesStart: 0,
                verticesCount: 3,
                indexStart: 0,
                indexCount: 3,
            })),
        })),
    };
    const imported = await importPinnedModuleFetching<{
        loadBabylon(
            engine: object,
            url: string,
            options: object,
        ): Promise<{ entities: Array<{ material: { alpha: number } }> }>;
    }>("loader-babylon/load-babylon.js", () =>
        Buffer.from(JSON.stringify(document)),
    );
    let expected: { alpha: number[]; equal: boolean[][] };
    try {
        const loaded = await imported.module.loadBabylon(
            {
                _device: {
                    createBuffer({ size }: { size: number }) {
                        const bytes = new ArrayBuffer(size);
                        return { getMappedRange: () => bytes, unmap() {} };
                    },
                },
            },
            "https://fixture/submeshes.babylon",
            { loadTextures: false },
        );
        const materials = loaded.entities.map((mesh) => mesh.material);
        expected = {
            alpha: materials.map((material) => material.alpha),
            equal: materials.map((left) =>
                materials.map((right) => left === right),
            ),
        };
        assert.equal(materials.length, 13);
    } finally {
        imported.release();
    }
    const changed = lowerBabylonMeshConstruction(
        doctoredContext(
            "src/loader-babylon/load-babylon.ts",
            "else if (matIds && matIds.length === 1)",
            "else if (matIds && matIds.length === 2)",
        ),
    ).replace("construct_babylon_meshes(", "construct_changed_materials(");
    const directory = resolve("artifacts/test-babylon-submesh-material");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "source.json"), JSON.stringify(document));
    writeFileSync(join(directory, "expected.json"), JSON.stringify(expected));
    runBabylonLoaderCheck(
        native,
        directory,
        changed,
        `    Json document, expected;
    std::ifstream("source.json") >> document;
    std::ifstream("expected.json") >> expected;
    Engine engine;
    const auto loaded=load_babylon(engine,"source.json");
    const auto& asset=engine.assets.at(loaded.value);
    assert(asset.meshes.size()==expected.at("alpha").size());
    std::vector<MaterialHandle> selected;
    for(const auto mesh:asset.meshes) selected.push_back(engine.meshes.at(mesh.value).material);
    for(std::size_t a=0;a<selected.size();++a) {
        assert(engine.materials.at(selected[a].value).alpha==expected.at("alpha")[a].get<float>());
        for(std::size_t b=0;b<selected.size();++b) assert((selected[a]==selected[b])==expected.at("equal")[a][b].get<bool>());
    }
    assert(engine.materials.size()==11);
    std::unordered_map<std::string,MaterialHandle> materials;
    std::unordered_map<std::string,std::vector<std::string>> multi;
    load_babylon_material_maps(engine,document,"",babylon_scene_ambient(document),false,materials,multi);
    std::vector<BabylonHierarchyNode> nodes;
    BabylonNodeMap node_map;
    std::unordered_map<std::string,std::vector<std::size_t>> meshes_by_id;
    std::vector<std::size_t> all_meshes;
    auto many=document.at("meshes")[1];
    many.at("subMeshes")=Json::array({{{"materialIndex",5},{"indexStart",0},{"indexCount",3}}});
    construct_changed_materials(engine,Json::array({many}),materials,multi,nodes,node_map,meshes_by_id,all_meshes);
    assert(engine.meshes.back().material==materials.at("one"));`,
    );
});

test("Babylon submesh defaults and index slices follow the pinned loader", async (t) => {
    const native = optionalNativeFixtureTools();
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const ranges = [
        undefined,
        null,
        [],
        ...[
            [0, 0],
            [3, 99],
            [-3, 3],
            [-3, 99],
            [1.9, 2.9],
            [9, 3],
        ].map(([indexStart, indexCount]) => [
            {
                materialIndex: 0,
                verticesStart: 0,
                verticesCount: 4,
                indexStart,
                indexCount,
            },
        ]),
    ];
    const document = {
        meshes: ranges.map((subMeshes, index) => ({
            id: String(index),
            name: String(index),
            subMeshes,
            positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0],
            normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
            indices: [0, 1, 2, 0, 2, 3],
        })),
    };
    const imported = await importPinnedModuleFetching<{
        loadBabylon(
            engine: object,
            url: string,
            options: object,
        ): Promise<{ entities: Array<{ _cpuIndices: Uint32Array }> }>;
    }>("loader-babylon/load-babylon.js", () =>
        Buffer.from(JSON.stringify(document)),
    );
    let expected: number[][];
    try {
        const loaded = await imported.module.loadBabylon(
            {
                _device: {
                    createBuffer({ size }: { size: number }) {
                        const bytes = new ArrayBuffer(size);
                        return { getMappedRange: () => bytes, unmap() {} };
                    },
                },
            },
            "https://fixture/indices.babylon",
            { loadTextures: false },
        );
        expected = loaded.entities.map((mesh) => [...mesh._cpuIndices]);
        assert.equal(expected.length, 7);
    } finally {
        imported.release();
    }
    const changed = cppFunction(
        lowerBabylonSubmeshDefaults(
            doctoredContext(
                "src/loader-babylon/load-babylon.ts",
                "indexStart: 0,",
                "indexStart: 3,",
            ),
        ),
        "Json babylon_submeshes(",
    ).replace("babylon_submeshes(", "changed_submeshes(");
    const directory = resolve("artifacts/test-babylon-submesh-indices");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "source.json"), JSON.stringify(document));
    writeFileSync(join(directory, "expected.json"), JSON.stringify(expected));
    runBabylonLoaderCheck(
        native,
        directory,
        changed,
        `    Json expected;
    std::ifstream("expected.json") >> expected;
    Engine engine;
    const auto loaded=load_babylon(engine,"source.json");
    Json actual=Json::array();
    for(const auto mesh:engine.assets.at(loaded.value).meshes)
        actual.push_back(engine.geometries.at(engine.meshes.at(mesh.value).geometry).indices);
    assert(actual==expected);
    const auto changed=changed_submeshes(Json::object(),12,6);
    assert(changed[0].at("indexStart")==3 && changed[0].at("verticesCount")==4);`,
    );
});
