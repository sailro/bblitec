import assert from "node:assert/strict";
import test from "node:test";
import { CompileError, compileSource } from "../src/compiler.js";

// The recursive-visitor spelling of the container flatten: two type
// guards, a visitor that pushes and descends, and the driver that seeds it
// from the container's entities. Scenes 41, 47, 104 and 105 write it this
// way; scenes 149 and 229 write the worklist arrangement instead.
const exactWalk = `
function isMeshNode(node: unknown): node is Mesh {
    return typeof node === "object" && node !== null && "_gpu" in node;
}

function hasChildren(node: unknown): node is { children: SceneNode[] } {
    return typeof node === "object" && node !== null && "children" in node && Array.isArray((node as { children?: unknown }).children);
}

function collectMeshes(node: unknown, meshes: Mesh[]): void {
    if (isMeshNode(node)) {
        meshes.push(node);
    }
    if (hasChildren(node)) {
        for (const child of node.children) {
            collectMeshes(child, meshes);
        }
    }
}`;

const twoMeshDocument = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
        { name: "root", children: [1, 2] },
        { name: "left", mesh: 0 },
        { name: "right", mesh: 0 },
    ],
    meshes: [{ name: "Mesh", primitives: [{}] }],
};

function gltfDataUrl(document: Record<string, unknown>): string {
    return (
        "data:model/gltf+json;base64," +
        Buffer.from(JSON.stringify(document), "utf8").toString("base64")
    );
}

function compileWalk(
    walk = exactWalk,
    document = twoMeshDocument,
    after = "",
) {
    return compileSource(`
        import {
            createEngine,
            createSphere,
            createStandardMaterial,
            loadGltf,
        } from "@babylonjs/lite";
        import type { Mesh, SceneNode } from "@babylonjs/lite";

        ${walk}

        async function main() {
            const engine = await createEngine({});
            const container = await loadGltf(engine, ${JSON.stringify(
                gltfDataUrl(document),
            )});
            const meshes: Mesh[] = [];
            for (const entity of container.entities) {
                collectMeshes(entity, meshes);
            }
            ${after}
            for (const mesh of meshes) {
                mesh.material = createStandardMaterial();
            }
        }
        void main();
    `);
}

test("the recursive-visitor flatten retains pinned preorder", () => {
    const result = compileWalk();

    // The consumer uses the observed preorder separately from flat storage.
    assert.match(
        result.cpp,
        /for \(const bbl::MeshHandle [A-Za-z0-9_]+ : bbl::asset_mesh_walk\([^\n]+, 0\)\)/,
    );
    // Neither half of the folded pair survives: no native list is
    // declared for the empty `Mesh[]`, and the driver loop emits nothing.
    assert.doesNotMatch(result.cpp, /std::vector<bbl::MeshHandle> [A-Za-z0-9_]*meshes/);
    assert.doesNotMatch(result.cpp, /collect_meshes/);
    assert.equal(result.manifest.sceneMaterialCount, 2);
    assert.deepEqual(result.manifest.sceneMaterialGltfAssetsBefore, [1, 1]);
});

test("material construction counts node instances and primitives, not mesh definitions", () => {
    const result = compileWalk(exactWalk, {
        ...twoMeshDocument,
        meshes: [
            { name: "used", primitives: [{}, {}] },
            { name: "unused", primitives: [{}, {}, {}] },
        ],
    });
    assert.equal(result.manifest.sceneMaterialCount, 4);
    assert.equal(result.cpp.match(/bbl::create_standard_material\(/g)?.length, 1);
    assert.match(result.cpp, /for \(const bbl::MeshHandle /);
});

test("a guard testing a field that is not the renderable one is refused", () => {
    const walk = exactWalk.replace('"_gpu" in node', '"_skeleton" in node');

    assert.throws(
        () => compileWalk(walk),
        (error: unknown) =>
            error instanceof CompileError &&
            /callback conditions/.test(error.message),
    );
});

test("a visitor that filters the children it descends into is refused", () => {
    const walk = exactWalk.replace(
        "            collectMeshes(child, meshes);",
        "            if (isMeshNode(child)) { collectMeshes(child, meshes); }",
    );

    assert.throws(
        () => compileWalk(walk),
        (error: unknown) =>
            error instanceof CompileError &&
            /callback conditions/.test(error.message),
    );
});

test("appending to the folded list refuses rather than growing the asset's", () => {
    assert.throws(
        () =>
            compileWalk(
                exactWalk,
                twoMeshDocument,
                "meshes.push(createSphere(engine, { diameter: 1 }));",
            ),
        (error: unknown) =>
            error instanceof CompileError &&
            /'meshes\.push' on handle-collection/.test(error.message),
    );
});

test("a visitor that collects something other than the node is refused", () => {
    const walk = exactWalk.replace(
        "        meshes.push(node);",
        "        meshes.push(node);\n        meshes.push(node);",
    );

    assert.throws(
        () => compileWalk(walk),
        (error: unknown) =>
            error instanceof CompileError &&
            /callback conditions/.test(error.message),
    );
});

// A `.babylon` container is not one root: the pinned loader returns
// `[...lights, ...rootMeshes, ...rootTransformNodes]`, and the same flatten
// walks past the lights into the roots. The generated loader records a mesh
// per submesh of every visible node that declares no `parentId`, so the walk
// and the record name the same meshes exactly when the file parents nothing
// — which is read out of the document rather than assumed.
function babylonDataUrl(document: Record<string, unknown>): string {
    return (
        "data:application/json;base64," +
        Buffer.from(JSON.stringify(document), "utf8").toString("base64")
    );
}

const flatBabylonDocument = {
    meshes: [
        {
            name: "skull",
            id: "skull",
            positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
            normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
            indices: [0, 1, 2],
        },
    ],
    lights: [{ type: 0, position: [0, 1, 0] }],
};

function compileBabylonWalk(
    document: Record<string, unknown> = flatBabylonDocument,
    options = "{ loadCamera: false, loadTextures: false }",
) {
    return compileSource(`
        import {
            createEngine,
            createStandardMaterial,
            loadBabylon,
        } from "@babylonjs/lite";
        import type { Mesh, SceneNode } from "@babylonjs/lite";

        ${exactWalk}

        async function main() {
            const engine = await createEngine({});
            const container = await loadBabylon(engine, ${JSON.stringify(
                babylonDataUrl(document),
            )}, ${options});
            const meshes: Mesh[] = [];
            for (const entity of container.entities) {
                collectMeshes(entity, meshes);
            }
            for (const mesh of meshes) {
                mesh.material = createStandardMaterial();
            }
        }
        void main();
    `);
}

test("a .babylon container's flatten answers with its own mesh list", () => {
    const result = compileBabylonWalk();

    assert.match(
        result.cpp,
        /for \(const bbl::MeshHandle [A-Za-z0-9_]+ : [A-Za-z0-9_.]*engine\.assets\[[^\]]+\]\.meshes\)/,
    );
    assert.doesNotMatch(
        result.cpp,
        /std::vector<bbl::MeshHandle> [A-Za-z0-9_]*meshes/,
    );
    assert.doesNotMatch(result.cpp, /collect_meshes/);
});

test("a .babylon container that parents a visible node refuses the flatten", () => {
    assert.throws(
        () =>
            compileBabylonWalk({
                ...flatBabylonDocument,
                meshes: [
                    ...flatBabylonDocument.meshes,
                    {
                        name: "jaw",
                        id: "jaw",
                        parentId: "skull",
                        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
                        normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
                        indices: [0, 1, 2],
                    },
                ],
            }),
        (error: unknown) =>
            error instanceof CompileError &&
            /parents 'jaw' under 'skull'/.test(error.message) &&
            /records only for unparented nodes/.test(error.message),
    );
});

test("loadBabylon refuses maxMeshes, which would shorten the container", () => {
    assert.throws(
        () => compileBabylonWalk(flatBabylonDocument, "{ maxMeshes: 1 }"),
        (error: unknown) =>
            error instanceof CompileError &&
            /loadBabylon takes loadCamera and loadTextures/.test(
                error.message,
            ),
    );
});
