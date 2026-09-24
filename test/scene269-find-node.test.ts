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
    target = "findNode",
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
            setParent(${target}(root, "Target")!, parent);
        }
        void main();
    `);
}

test("Scene 269 findNode resolves the pin's DFS to the matching node's transform node", () => {
    const result = compileFindNode({
        asset: { version: "2.0" },
        scenes: [{ nodes: [0] }],
        nodes: [{ name: "Target", mesh: 0 }],
        meshes: [{ name: "Mesh", primitives: [{}] }],
    });
    assert.match(
        result.cpp,
        /const bbl::TransformNodeHandle (\w+) = [^\n]+\.nodes\.at\(0\);[\s\S]*bbl::reparent_transform_node\(v_engine, \1, v_parent\)/,
    );
    // Holding an imported node reaches the node-carrying load.
    assert.ok(result.manifest.features.includes("scene:node-transforms"));
    assert.ok(result.manifest.features.includes("mesh:transform-node"));
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

test("resolves renamed descendant searches and their recursive references", () => {
    const result = compileFindNode(
        {
            asset: { version: "2.0" },
            nodes: [{ name: "Target", mesh: 0 }],
            meshes: [{ primitives: [{}] }],
        },
        exactFindNode.replaceAll("findNode", "lookupDescendant"),
        "lookupDescendant",
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
            assert.match(
                error.message,
                /Unsupported property value 'root.name'/,
            );
            return true;
        },
    );
});

test("Scene 269 findNode resolves a transform-only node and a node before its own meshes", () => {
    for (const [nodes, meshes] of [
        // A transform-only node is a transform node like any other.
        [
            [
                { name: "Target", children: [1] },
                { name: "Child", mesh: 0 },
            ],
            [{ primitives: [{}] }],
        ],
        // A node with several primitives is still one node.
        [[{ name: "Target", mesh: 0 }], [{ primitives: [{}, {}] }]],
    ] as const) {
        const result = compileFindNode({
            asset: { version: "2.0" },
            scenes: [{ nodes: [0] }],
            nodes,
            meshes,
        });
        assert.match(result.cpp, /\.nodes\.at\(0\);/);
    }
});

test("Scene 269 findNode visits a node's child nodes before its meshes", () => {
    const result = compileFindNode({
        asset: { version: "2.0" },
        scenes: [{ nodes: [0] }],
        nodes: [{ name: "Parent", mesh: 0, children: [1] }, { name: "Target" }],
        meshes: [{ name: "Target", primitives: [{}] }],
    });
    assert.match(result.cpp, /\.nodes\.at\(1\);/);
});

test("Scene 269 findNode resolves a uniquely named mesh to its record", () => {
    const result = compileFindNode({
        asset: { version: "2.0" },
        scenes: [{ nodes: [0] }],
        nodes: [{ name: "Holder", mesh: 0 }],
        meshes: [{ name: "Target", primitives: [{}] }],
    });
    assert.match(result.cpp, /\.name == "Target"\) \{/);
    assert.match(result.cpp, /bbl::set_mesh_parent\(/);
});

test("Scene 269 findNode refuses a mesh name several primitives carry", () => {
    assert.throws(
        () =>
            compileFindNode({
                asset: { version: "2.0" },
                scenes: [{ nodes: [0] }],
                nodes: [{ name: "Holder", mesh: 0 }],
                meshes: [{ name: "Target", primitives: [{}, {}] }],
            }),
        /names several primitives 'Target'/,
    );
});
