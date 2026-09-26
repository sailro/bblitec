import assert from "node:assert/strict";
import test from "node:test";
import { GLTF_MESH_PLAN } from "../src/gltf-document.js";
import { asObject, asRecords, type JsonObject } from "../src/json-fields.js";
import {
    packageGltfMeshPlan,
    packagedGltfMeshPlan,
} from "../src/gltf-mesh-plan.js";
import type { LoweringContext } from "../src/lowering/context.js";
import { doctoredContext } from "./doctored-store.js";
import {
    gltfMeshPlan,
    meshPlanFixture,
    readPackedGltfAttribute,
} from "./gltf-mesh-fixture.js";

function fixture(instanced = false) {
    const document: JsonObject = {
        nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{}] }],
        scenes: [{ nodes: [0] }],
    };
    const triangle = meshPlanFixture(document);
    if (!instanced) return triangle;
    document.extensionsUsed = ["EXT_mesh_gpu_instancing"];
    const node = asRecords(document.nodes)[0]!;
    node.translation = [10, 0, 0];
    node.extensions = {
        EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 1 } },
    };
    const positions = new Float32Array([1, 0, 0, 3, 2, 0]);
    const bytes = Buffer.concat([
        Buffer.from(triangle.bin.buffer),
        Buffer.from(positions.buffer),
    ]);
    asRecords(document.buffers)[0]!.byteLength = bytes.byteLength;
    document.bufferViews = [
        ...asRecords(document.bufferViews),
        {
            buffer: 0,
            byteOffset: triangle.bin.byteLength,
            byteLength: positions.byteLength,
        },
    ];
    document.accessors = [
        ...asRecords(document.accessors),
        { bufferView: 1, componentType: 5126, count: 2, type: "VEC3" },
    ];
    return {
        document,
        bin: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    };
}

async function packageFixture(
    input = fixture(),
    context?: LoweringContext,
    nodeTransforms = false,
) {
    const binary = await packageGltfMeshPlan(
        input.document,
        input.bin,
        context,
        { nodeTransforms },
    );
    const mesh = packagedGltfMeshPlan(input.document).meshes[0]!;
    return {
        document: input.document,
        mesh,
        attribute: (index: number) =>
            readPackedGltfAttribute(input.document, binary, index),
    };
}

test("mesh placement follows source hierarchy, local bounds and primitive winding", async () => {
    const input = fixture();
    asRecords(input.document.nodes)[0]!.scale = [-2, 3, 1];
    asRecords(input.document.nodes)[0]!.translation = [10, 20, 30];
    const result = await packageFixture(input);
    assert.deepEqual(
        result.attribute(result.mesh.setup.bounds),
        [0, 0, 0, 1, 1, 0],
    );
    assert.deepEqual(
        result.attribute(result.mesh.setup.world).slice(12, 15),
        [-10, 20, 30],
    );
    assert.equal(result.mesh.setup.clockwise, true);
    assert.equal(result.mesh.setup.visibleDefined, false);
    const changed = await packageFixture(
        fixture(),
        doctoredContext(
            "src/loader-gltf/load-gltf.ts",
            'createTransformNode("__root__", 0, 0, 0,',
            'createTransformNode("__root__", 6, 0, 0,',
        ),
    );
    assert.equal(changed.attribute(changed.mesh.setup.world)[12], 6);
    const detached = await packageFixture(
        fixture(),
        doctoredContext(
            "src/scene/scene-core.ts",
            "(child as unknown as SceneNode).parent = entity as unknown as SceneNode;",
            "(child as unknown as SceneNode).parent = null;",
        ),
    );
    assert.deepEqual(
        detached.attribute(detached.mesh.setup.world),
        [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    );
});

test("a scene writing node transforms packages the pin's node hierarchy", async () => {
    const plain = fixture();
    await packageFixture(plain);
    assert.equal(packagedGltfMeshPlan(plain.document).hierarchy, undefined);
    // A transform-only node over a matrix node over the primitive's node.
    const input = fixture();
    input.document.nodes = [
        {
            name: "pivot",
            translation: [10, 20, 30],
            scale: [-2, 3, 1],
            children: [1],
        },
        {
            matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 5, 6, 1],
            children: [2],
        },
        { name: "leaf", mesh: 0, rotation: [0, 0.6, 0, 0.8] },
    ];
    input.document.scenes = [{ nodes: [0] }];
    const result = await packageFixture(input, undefined, true);
    const hierarchy = packagedGltfMeshPlan(result.document).hierarchy!;
    // The synthetic root's own RH-to-LH TRS, then the scene's roots.
    assert.deepEqual(hierarchy.root, {
        translation: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scaling: [-1, 1, 1],
    });
    assert.deepEqual(hierarchy.rootChildren, [0]);
    const [pivot, matrix, leaf] = hierarchy.nodes;
    assert.deepEqual(
        { ...pivot, matrix: undefined },
        {
            name: "pivot",
            parent: -1,
            translation: [10, 20, 30],
            rotation: [0, 0, 0, 1],
            scaling: [-2, 3, 1],
            matrix: undefined,
            locked: false,
        },
    );
    // A matrix node keeps its raw local, locked against TRS writes, and the
    // pin's `node_<index>` name for a node the file leaves unnamed.
    assert.equal(matrix?.name, "node_1");
    assert.equal(matrix?.parent, 0);
    assert.equal(matrix?.locked, true);
    assert.deepEqual(
        result.attribute(matrix.matrix!),
        [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 5, 6, 1],
    );
    assert.equal(leaf?.parent, 1);
    assert.deepEqual(leaf?.rotation, [0, 0.6, 0, 0.8]);
    assert.equal(result.mesh.node, 2);
});

test("a node-carrying load refuses a light the runtime places from its loaded node world", async () => {
    const lit = fixture();
    lit.document.extensionsUsed = ["KHR_lights_punctual"];
    lit.document.extensions = {
        KHR_lights_punctual: { lights: [{ type: "point" }] },
    };
    asRecords(lit.document.nodes)[0]!.extensions = {
        KHR_lights_punctual: { light: 0 },
    };
    await assert.rejects(
        packageFixture(lit, undefined, true),
        /punctual lights/,
    );
});

test("source bounds calculations and constructors determine packaged boxes", async () => {
    const changed = await packageFixture(
        fixture(),
        doctoredContext(
            "src/loader-gltf/load-gltf.ts",
            "const [boundMin, boundMax] = computeAabb(meshData._positions!);",
            "const [boundMin, boundMax] = computeAabb(meshData._positions!); boundMax[0] += 2;",
        ),
    );
    assert.deepEqual(
        changed.attribute(changed.mesh.setup.bounds),
        [0, 0, 0, 3, 1, 0],
    );
});

test("source instancing hook owns matrix data, placement bounds and activation", async () => {
    const original = await packageFixture(fixture(true));
    assert.equal(original.mesh.setup.instances?.count, 2);
    assert.equal(
        original.attribute(original.mesh.setup.instances.matrices)[12],
        1,
    );
    const moved = await packageFixture(
        fixture(true),
        doctoredContext(
            "src/loader-gltf/gltf-feature-gpu-instancing.ts",
            "const tx = translation ? translation[i * 3]! : 0;",
            "const tx = translation ? translation[i * 3]! + 5 : 0;",
        ),
    );
    assert.equal(moved.attribute(moved.mesh.setup.instances!.matrices)[12], 6);
    const disabled = await packageFixture(
        fixture(true),
        doctoredContext(
            "src/loader-gltf/load-gltf.ts",
            "_appendEnabledGltfFeatures(json, features);",
            "features.length = 0;",
        ),
    );
    assert.equal(disabled.mesh.setup.instances, undefined);
});

test("primitive state follows its source builder and rejects unrepresented GPU state", async () => {
    const make = () => {
        const input = fixture();
        asRecords(asRecords(input.document.meshes)[0]!.primitives)[0]!.mode = 1;
        return input;
    };
    assert.equal(
        (await packageFixture(make())).mesh.setup.topology,
        "line-list",
    );
    const changed = await packageFixture(
        make(),
        doctoredContext(
            "src/material/pbr/pbr-primitive-topology.ts",
            'topo === 2 ? "line-list"',
            'topo === 2 ? "point-list"',
        ),
    );
    assert.equal(changed.mesh.setup.topology, "point-list");
    await assert.rejects(
        packageFixture(
            make(),
            doctoredContext(
                "src/material/pbr/pbr-primitive-topology.ts",
                'prim.cullMode = "none";',
                'prim.cullMode = "front";',
            ),
        ),
        /primitive state/,
    );
    const result = await packageFixture();
    const plan = asObject(result.document[GLTF_MESH_PLAN])!;
    asRecords(plan.meshes)[0]!.setup = { ...result.mesh.setup, world: 999 };
    assert.throws(
        () => packagedGltfMeshPlan(result.document),
        /mesh placement/,
    );
});

function visibilityFixture() {
    const hidden = { KHR_node_visibility: { visible: false } };
    return meshPlanFixture({
        extensionsUsed: ["KHR_node_visibility"],
        nodes: [
            { children: [1], extensions: hidden },
            {
                mesh: 0,
                children: [2],
                extensions: { KHR_node_visibility: { visible: true } },
            },
            { mesh: 1 },
            { mesh: 2 },
            { mesh: 2, extensions: hidden },
        ],
        meshes: [
            { primitives: [{}, {}] },
            { primitives: [{}] },
            { primitives: [{}] },
        ],
        scenes: [{ nodes: [0, 3] }],
    });
}

test("initial visibility follows source node objects, primitive children and selected roots", async () => {
    const { document, bin } = visibilityFixture();
    const plan = await gltfMeshPlan(document, bin);
    assert.deepEqual(plan.nodeVisibility, [false, false, false, true, true]);
    assert.deepEqual(
        plan.meshes.map((mesh) => mesh.setup.visible),
        [false, false, false, true, true],
    );
    assert.deepEqual(
        plan.meshes.map((mesh) => mesh.setup.visibleDefined),
        [true, true, true, false, false],
    );
    const changed = await gltfMeshPlan(
        document,
        bin,
        doctoredContext(
            "src/scene/visibility.ts",
            "if (cascade(node, v))",
            "if (cascade(node, !v))",
        ),
    );
    assert.deepEqual(changed.nodeVisibility, [true, true, true, true, true]);
    assert.ok(changed.meshes.every((mesh) => mesh.setup.visible));
    const disabled = await gltfMeshPlan(
        document,
        bin,
        doctoredContext(
            "src/loader-gltf/load-gltf.ts",
            "_appendEnabledGltfFeatures(json, features);",
            "features.length = 0;",
        ),
    );
    assert.ok(disabled.meshes.every((mesh) => mesh.setup.visible));
});

test("asset feature scheduling executes source control flow and refuses unknown fragments", async () => {
    const { document, bin } = visibilityFixture();
    const skipped = await gltfMeshPlan(
        document,
        bin,
        doctoredContext(
            "src/loader-gltf/load-gltf.ts",
            "const assetFragments = await Promise.all(features.flatMap",
            "const assetFragments = await Promise.all([].flatMap",
        ),
    );
    assert.ok(skipped.meshes.every((mesh) => mesh.setup.visible));
    await assert.rejects(
        gltfMeshPlan(
            document,
            bin,
            doctoredContext(
                "src/loader-gltf/gltf-ext-node-visibility.ts",
                "return {};",
                "return { unrepresented: true };",
            ),
        ),
        /mesh asset fragment/,
    );
    await packageGltfMeshPlan(document, bin);
    const plan = packagedGltfMeshPlan(document);
    for (const nodeVisibility of [
        undefined,
        [],
        [true],
        [true, true, true, true, "false"],
    ]) {
        assert.throws(
            () =>
                packagedGltfMeshPlan({
                    ...document,
                    [GLTF_MESH_PLAN]: { ...plan, nodeVisibility },
                }),
            /Invalid/,
        );
    }
});
