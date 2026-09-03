import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CompileError, compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { GizmoLowerer } from "../src/lowering/gizmo-lowerer.js";
import { SceneLowerer } from "../src/lowering/scene-lowerer.js";

test("compiles mixed TransformNode children in source insertion order", () => {
    const result = compileSource(`
        import {
            addToScene,
            createBox,
            createEngine,
            createSceneContext,
            createTransformNode,
            type TransformNode,
        } from "@babylonjs/lite";

        const engine = await createEngine({});
        const scene = createSceneContext(engine);
        function attach(
            child: TransformNode,
            parent: TransformNode,
        ): void {
            child.parent = parent;
            parent.children.push(child);
        }

        const root = createTransformNode("root");
        const first = createBox(engine, 1);
        const branch = createTransformNode("branch");
        const second = createBox(engine, 1);
        attach(first, root);
        attach(branch, root);
        attach(second, branch);
        addToScene(scene, root);
        addToScene(scene, first);
    `);

    const hierarchyCalls = [
        ...result.cpp.matchAll(
            /bbl::(set_mesh_transform_parent|set_transform_node_parent|push_transform_node_child)\([^;]+;/g,
        ),
    ].map((match) => match[1]);
    assert.deepEqual(hierarchyCalls, [
        "set_mesh_transform_parent",
        "push_transform_node_child",
        "set_transform_node_parent",
        "push_transform_node_child",
        "set_mesh_transform_parent",
        "push_transform_node_child",
    ]);
    assert.equal(
        result.cpp.match(/bbl::add_to_scene\(/g)?.length,
        2,
    );
    assert.ok(
        result.manifest.features.includes("mesh:transform-node"),
    );
});

test("keeps a direct parent write out of the traversal list", () => {
    const result = compileSource(`
        import {
            addToScene,
            createBox,
            createEngine,
            createSceneContext,
            createTransformNode,
        } from "@babylonjs/lite";

        const engine = await createEngine({});
        const scene = createSceneContext(engine);
        const root = createTransformNode("root");
        const child = createBox(engine, 1);
        child.parent = root;
        addToScene(scene, root);
    `);

    assert.match(result.cpp, /bbl::set_mesh_transform_parent\(/);
    assert.doesNotMatch(
        result.cpp,
        /bbl::push_transform_node_child\(/,
    );
});

test("refuses non-mesh and non-TransformNode traversal children", () => {
    const cases = [
        {
            name: "light",
            imports: "createHemisphericLight,",
            value:
                "createHemisphericLight({ x: 0, y: 1, z: 0 }, 1)",
            kind: "light",
        },
        {
            name: "camera",
            imports: "createArcRotateCamera,",
            value:
                "createArcRotateCamera(0, 1, 5, { x: 0, y: 0, z: 0 })",
            kind: "camera",
        },
        {
            name: "scene",
            imports: "",
            value: "scene",
            kind: "scene",
        },
    ] as const;

    for (const invalid of cases) {
        const fileName = `hierarchy-invalid-${invalid.name}.ts`;
        assert.throws(
            () =>
                compileSource(
                    `
                    import {
                        ${invalid.imports}
                        createEngine,
                        createSceneContext,
                        createTransformNode,
                        type TransformNode,
                    } from "@babylonjs/lite";

                    const engine = await createEngine({});
                    const scene = createSceneContext(engine);
                    const root = createTransformNode("root");
                    const child = ${invalid.value};
                    root.children.push(
                        child as unknown as TransformNode,
                    );
                `,
                    { fileName },
                ),
            (error: unknown) => {
                assert.ok(error instanceof CompileError);
                assert.match(error.message, new RegExp(`^${fileName}:`));
                assert.match(
                    error.message,
                    new RegExp(
                        "children\\.push supports exactly mesh and " +
                            `transform-node values, received ${invalid.kind}`,
                    ),
                );
                return true;
            },
        );
    }
});

test("emits a depth-first ordered TransformNode traversal", () => {
    const source = new SceneLowerer(
        new LoweringContext(),
    ).lowerCore({ transformNodes: true }).source;

    assert.match(
        source,
        /for \(const TransformNodeChild& entry : record\.children\) \{[\s\S]{0,220}std::get_if<MeshHandle>[\s\S]{0,220}set_mesh_transform_parent\(engine, \*mesh, node\);[\s\S]{0,100}add_to_scene\(scene, \*mesh\);/,
    );
    assert.match(
        source,
        /const TransformNodeHandle child =\s*std::get<TransformNodeHandle>\(entry\);[\s\S]{0,100}set_transform_node_parent\(engine, child, node\);[\s\S]{0,100}add_transform_node_children\(scene, child\);/,
    );

    const addMeshStart = source.indexOf(
        "void add_to_scene(Scene& scene, MeshHandle mesh)",
    );
    const addMeshEnd = source.indexOf(
        "// A static glTF mesh",
        addMeshStart,
    );
    const addMesh = source.slice(addMeshStart, addMeshEnd);
    assert.match(addMesh, /scene\.meshes\.push_back\(mesh\);/);
    assert.doesNotMatch(addMesh, /find|none_of|unique/);
});

test("propagates nested dirty state through deduplicated parent links", () => {
    const source = new SceneLowerer(
        new LoweringContext(),
    ).lowerCore({ transformNodes: true }).source;

    assert.match(
        source,
        /void mark_transform_node_dirty[\s\S]{0,500}for \(const MeshHandle child : record\.parented_meshes\)[\s\S]{0,180}for \(const TransformNodeHandle child : record\.parented_nodes\)[\s\S]{0,100}mark_transform_node_dirty\(engine, child\);/,
    );
    assert.match(
        source,
        /old_children\.erase\(\s*std::remove\(old_children\.begin\(\), old_children\.end\(\), node\),\s*old_children\.end\(\)\);/,
    );
    assert.match(
        source,
        /std::find\(new_children\.begin\(\), new_children\.end\(\), node\) ==\s*new_children\.end\(\)/,
    );
    assert.match(
        source,
        /std::find\(new_children\.begin\(\), new_children\.end\(\), mesh\) ==\s*new_children\.end\(\)/,
    );
});

test("preserves duplicate traversal pushes and explicit mesh additions", () => {
    const source = new SceneLowerer(
        new LoweringContext(),
    ).lowerCore({ transformNodes: true, parenting: true }).source;

    const meshPushStart = source.indexOf(
        "void push_transform_node_child(\n" +
            "    Engine& engine,\n" +
            "    TransformNodeHandle node,\n" +
            "    MeshHandle child)",
    );
    const nodePushStart = source.indexOf(
        "void push_transform_node_child(\n" +
            "    Engine& engine,\n" +
            "    TransformNodeHandle node,\n" +
            "    TransformNodeHandle child)",
    );
    const meshPush = source.slice(meshPushStart, nodePushStart);
    assert.match(
        meshPush,
        /children\.emplace_back\(child\);/,
    );
    assert.doesNotMatch(meshPush, /find|unique/);
    const unlinkStart = source.indexOf(
        "template <typename Children>\nvoid unlink_child_links",
    );
    const linkStart = source.indexOf(
        "template <typename Children>\nvoid link_child_links",
        unlinkStart,
    );
    const unlink = source.slice(unlinkStart, linkStart);
    assert.match(unlink, /const auto traversal = std::find_if/);
    assert.match(unlink, /children\.erase\(traversal\);/);
    assert.match(
        unlink,
        /registered\.erase\(\s*std::remove/,
    );
});

test("refuses traversal and parent cycles before recursive evaluation", () => {
    const result = compileSource(`
        import {
            addToScene,
            createEngine,
            createSceneContext,
            createTransformNode,
        } from "@babylonjs/lite";

        const engine = await createEngine({});
        const scene = createSceneContext(engine);
        const first = createTransformNode("first");
        const second = createTransformNode("second");
        first.children.push(second);
        second.children.push(first);
        addToScene(scene, first);
    `);
    assert.equal(
        result.cpp.match(/bbl::push_transform_node_child\(/g)?.length,
        2,
    );

    const source = new SceneLowerer(
        new LoweringContext(),
    ).lowerCore({ transformNodes: true }).source;
    assert.match(
        source,
        /if \(active\[node\.value\]\) \{[\s\S]{0,120}"Transform-node traversal cycle detected\."/,
    );
    assert.match(
        source,
        /cursor\.value == node\.value \|\|[\s\S]{0,80}depth\+\+ >= engine\.transform_nodes\.size\(\)[\s\S]{0,120}"Transform-node parent cycle detected\."/,
    );
    assert.match(
        source,
        /validate_transform_node_traversal\(\*scene\.engine, node, active\);[\s\S]{0,100}add_transform_node_children\(scene, node\);/,
    );
});

test("gizmo bounds traverse mixed transform-node children", () => {
    const source = new GizmoLowerer(
        new LoweringContext(),
        ["gizmo:utility-layer", "gizmo:bounding-box"],
    ).lower().source;

    assert.match(source, /std::vector<TransformNodeChild> pending;/);
    assert.match(
        source,
        /std::holds_alternative<TransformNodeHandle>\(child\)/,
    );
    assert.match(source, /std::get<MeshHandle>\(child\)/);
});

test("keeps the native mixed child union separate from mesh children", () => {
    const runtime = readFileSync(
        "native/include/bblite/runtime.hpp",
        "utf8",
    );
    assert.match(
        runtime,
        /using TransformNodeChild =\s*std::variant<MeshHandle, TransformNodeHandle>;/,
    );

    const transformStart = runtime.indexOf(
        "struct TransformNodeRecord",
    );
    const meshStart = runtime.indexOf("struct MeshRecord", transformStart);
    const transformRecord = runtime.slice(transformStart, meshStart);
    const meshRecord = runtime.slice(meshStart, meshStart + 5000);
    assert.match(
        transformRecord,
        /std::vector<TransformNodeChild> children;/,
    );
    assert.match(meshRecord, /std::vector<MeshHandle> children;/);
    assert.doesNotMatch(
        meshRecord,
        /std::vector<TransformNodeChild> children;/,
    );
    assert.equal(
        runtime.match(
            /void push_transform_node_child\(\s*Engine& engine,\s*TransformNodeHandle node,\s*(?:MeshHandle|TransformNodeHandle) child\);/g,
        )?.length,
        2,
    );
});

test("omits TransformNode traversal code when the feature is absent", () => {
    const source = new SceneLowerer(
        new LoweringContext(),
    ).lowerCore().source;
    assert.doesNotMatch(
        source,
        /void add_to_scene\(Scene& scene, TransformNodeHandle node\)/,
    );
    assert.doesNotMatch(
        source,
        /void push_transform_node_child\(/,
    );
});
