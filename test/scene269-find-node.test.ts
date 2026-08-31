import assert from "node:assert/strict";
import test from "node:test";
import { CompileError, compileSource } from "../src/compiler.js";

const exactFindNode = `
function findNode(root: SceneNode, name: string): SceneNode | undefined {
    if (root.name === name) {
        return root;
    }
    for (const child of root.children) {
        const hit = findNode(child, name);
        if (hit) {
            return hit;
        }
    }
    return undefined;
}`;

function gltfDataUrl(document: Record<string, unknown>): string {
    return (
        "data:model/gltf+json;base64," +
        Buffer.from(JSON.stringify(document), "utf8").toString("base64")
    );
}

function compileFindNode(
    document: Record<string, unknown>,
    helper = exactFindNode,
) {
    const source = gltfDataUrl(document);
    return compileSource(`
        import {
            createEngine,
            createTransformNode,
            loadGltf,
            setParent,
        } from "@babylonjs/lite";
        import type { SceneNode } from "@babylonjs/lite";

        ${helper}

        async function main() {
            const engine = await createEngine({});
            const container = await loadGltf(engine, ${JSON.stringify(source)});
            const parent = createTransformNode("parent");
            const root = container.entities[0] as SceneNode;
            setParent(findNode(root, "Target")!, parent);
        }
        void main();
    `);
}

test("Scene 269 findNode lowers the exact DFS when one mesh record matches", () => {
    const result = compileFindNode({
        asset: { version: "2.0" },
        nodes: [{ name: "Target", mesh: 0 }],
        meshes: [{ name: "Mesh", primitives: [{}] }],
    });

    assert.match(
        result.cpp,
        /\.scene_node_name == "Target" \|\| [^\n]+\.name == "Target"/,
    );
    assert.match(result.cpp, /asset_descendant_found/);
});

test("lowers the existing null-returning DFS with a child type cast", () => {
    const helper = `
function findNode(root: SceneNode, name: string): SceneNode | null {
    if (root.name === name) {
        return root;
    }
    for (const child of root.children) {
        const found = findNode(child as SceneNode, name);
        if (found) {
            return found;
        }
    }
    return null;
}`;
    const result = compileFindNode(
        {
            asset: { version: "2.0" },
            nodes: [{ name: "Target", mesh: 0 }],
            meshes: [{ primitives: [{}] }],
        },
        helper,
    );

    assert.match(result.cpp, /asset_descendant_found/);
});

test("Scene 269 findNode refuses a helper with behavior beyond the exact DFS", () => {
    const changedHelper = `
function findNode(root: SceneNode, name: string): SceneNode | undefined {
    if (root.name === name) {
        return root;
    }
    if (root.children.length === 0) {
        return root;
    }
    for (const child of root.children) {
        const hit = findNode(child, name);
        if (hit) {
            return hit;
        }
    }
    return undefined;
}`;

    assert.throws(
        () =>
            compileFindNode(
                {
                    asset: { version: "2.0" },
                    nodes: [{ name: "Target", mesh: 0 }],
                    meshes: [{ primitives: [{}] }],
                },
                changedHelper,
            ),
        (error: unknown) => {
            assert.ok(error instanceof CompileError);
            assert.match(error.message, /only for the exact depth-first helper/);
            return true;
        },
    );
});

test("Scene 269 findNode refuses a named transform with no mesh handle", () => {
    assert.throws(
        () =>
            compileFindNode({
                asset: { version: "2.0" },
                nodes: [
                    { name: "Target", children: [1] },
                    { name: "Child", mesh: 0 },
                ],
                meshes: [{ primitives: [{}] }],
            }),
        /geometry-less node named 'Target'/,
    );
});

test("Scene 269 findNode refuses a matching multi-primitive mesh", () => {
    assert.throws(
        () =>
            compileFindNode({
                asset: { version: "2.0" },
                nodes: [{ name: "Target", mesh: 0 }],
                meshes: [{ primitives: [{}, {}] }],
            }),
        /one SceneNode DFS result cannot be represented by several native mesh handles/,
    );
});

test("Scene 269 findNode refuses two flattened records matching one name", () => {
    assert.throws(
        () =>
            compileFindNode({
                asset: { version: "2.0" },
                nodes: [
                    { name: "Target", mesh: 0 },
                    { name: "Other", mesh: 1 },
                ],
                meshes: [
                    { name: "First", primitives: [{}] },
                    { name: "Target", primitives: [{}] },
                ],
            }),
        /resolves 'Target' to 2 flattened mesh records/,
    );
});
