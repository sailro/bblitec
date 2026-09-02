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

test("the recursive-visitor flatten answers with the container's mesh list", () => {
    const result = compileWalk();

    // The consumer loops the asset's materialized meshes, which is the
    // same collection `getContainerMeshes` answers with.
    assert.match(
        result.cpp,
        /for \(const bbl::MeshHandle [A-Za-z0-9_]+ : [A-Za-z0-9_.]*engine\.assets\[[^\]]+\]\.meshes\)/,
    );
    // Neither half of the folded pair survives: no native list is
    // declared for the empty `Mesh[]`, and the driver loop emits nothing.
    assert.doesNotMatch(result.cpp, /std::vector<bbl::MeshHandle> [A-Za-z0-9_]*meshes/);
    assert.doesNotMatch(result.cpp, /collect_meshes/);
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
