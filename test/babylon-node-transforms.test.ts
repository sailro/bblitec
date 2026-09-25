import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { lowerBabylonMeshConstruction } from "../src/lowering/babylon-mesh-construction.js";
import { importPinnedModuleFetching } from "../src/pinned-shader-composer.js";
import { runBabylonLoaderCheck } from "./babylon-loader-fixture.js";
import { doctoredContext } from "./doctored-store.js";
import { optionalNativeFixtureTools } from "./native-fixture.js";

test("Babylon mesh and container transforms preserve source defaults and world composition", async (t) => {
    const native = optionalNativeFixtureTools();
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const inputs = [
        {},
        { position: null, rotation: null, scaling: null },
        {
            position: [16777217, -0.1234567890123, 0.7],
            rotation: [0.37, -0.71, 1.19],
            scaling: [2.5, -1, 0.25],
        },
        { position: [5, 7], rotation: [0.125], scaling: [0, 0.5] },
    ];
    const document = {
        meshes: inputs.flatMap((input, index) => [
            {
                ...input,
                id: `m${index}`,
                name: `m${index}`,
                positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
                normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
                indices: [0, 1, 2],
            },
            { ...input, id: `c${index}`, name: `c${index}` },
        ]),
    };
    const imported = await importPinnedModuleFetching<{
        loadBabylon(
            engine: object,
            url: string,
            options: object,
        ): Promise<{
            entities: Array<{
                name: string;
                position: { x: number; y: number; z: number };
                worldMatrix: Float32Array;
            }>;
        }>;
    }>("loader-babylon/load-babylon.js", () =>
        Buffer.from(JSON.stringify(document)),
    );
    let expected: Record<string, { position: number[]; world: number[] }>;
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
            "https://fixture/transforms.babylon",
            { loadTextures: false },
        );
        expected = Object.fromEntries(
            loaded.entities.map((node) => [
                node.name,
                {
                    position: [
                        node.position.x,
                        node.position.y,
                        node.position.z,
                    ],
                    world: [...node.worldMatrix],
                },
            ]),
        );
        assert.equal(Object.keys(expected).length, 8);
    } finally {
        imported.release();
    }
    const changed = lowerBabylonMeshConstruction(
        doctoredContext(
            "src/loader-babylon/load-babylon.ts",
            "md.scaling?.[2] ?? 1\n                    );",
            "md.scaling?.[2] ?? 2\n                    );",
        ),
    ).replace("construct_babylon_meshes(", "construct_changed_transforms(");
    const directory = resolve("artifacts/test-babylon-node-transforms");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "source.json"), JSON.stringify(document));
    writeFileSync(join(directory, "expected.json"), JSON.stringify(expected));
    // The loader constructs one node per source entry here (no entry
    // splits into submeshes), so node k is document entry k.
    runBabylonLoaderCheck(
        native,
        directory,
        changed,
        `    Json document, expected;
    std::ifstream("source.json") >> document;
    std::ifstream("expected.json") >> expected;
    const auto construct = [&](auto&& pass) {
        Engine engine;
        std::vector<BabylonHierarchyNode> nodes;
        BabylonNodeMap node_map;
        std::unordered_map<std::string,std::vector<std::size_t>> meshes_by_id;
        std::vector<std::size_t> all_meshes;
        pass(engine,document.at("meshes"),{},{},nodes,node_map,meshes_by_id,all_meshes);
        return nodes;
    };
    const auto nodes = construct(construct_babylon_meshes);
    assert(nodes.size()==expected.size());
    for(std::size_t index=0;index<nodes.size();++index) {
        const auto& transform=nodes[index].transform;
        const auto& want=expected.at(document.at("meshes")[index].at("name").get<std::string>());
        assert(transform.position.x==want.at("position")[0].get<double>());
        assert(transform.position.y==want.at("position")[1].get<double>());
        assert(transform.position.z==want.at("position")[2].get<double>());
        const auto world=upstream::trs_matrix(transform);
        for(std::size_t cell=0;cell<16;++cell) {
            const auto wanted=want.at("world")[cell].get<double>();
            assert(std::abs(double(world[cell])-wanted)<=1e-6*std::max(1.0,std::abs(wanted)));
        }
    }
    const auto changed = construct(construct_changed_transforms);
    assert(changed.at(0).transform.scaling.z==2 && changed.at(1).transform.scaling.z==1);`,
    );
});
