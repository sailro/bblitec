import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import { lowerPinnedFunction } from "./pinned-function-lowerer.js";
import {
    collectionBinding,
    type PinnedBinding,
} from "./pinned-numeric-lowerer.js";
import { recordAt } from "../compiler/record-access.js";
import { soleBindingName } from "../compiler/syntax.js";

const modulePath = "src/mesh/hierarchy-instance-pool.ts";

/** The retained binding array and the current mesh pool are separate source owners. */
export function lowerHierarchyInstanceOperations(
    context: LoweringContext,
): string {
    const binding = (
        cpp: string,
        type: PinnedBinding["type"] = "opaque",
    ): PinnedBinding => ({ cpp, type });
    const mesh = recordAt("engine.meshes", "binding.mesh");
    const members: ReadonlyMap<string, PinnedBinding> = new Map<
        string,
        PinnedBinding
    >([
        ["pool", binding("pool")],
        ["pool.count", binding("pool.count", "scalar")],
        ["pool.capacity", binding("pool.capacity", "scalar")],
        // Each pooled binding reads through the `binding` rows below.
        [
            "pool._bindings",
            collectionBinding(
                "pool.bindings",
                (element): Map<string, PinnedBinding> =>
                    new Map(
                        [...members]
                            .filter(
                                ([name]) =>
                                    name === "binding" ||
                                    name.startsWith("binding."),
                            )
                            .map(([name, value]) => [
                                name.replace(/^binding/, element),
                                value,
                            ]),
                    ),
            ),
        ],
        ["pool._scratch", binding("pool.scratch", "f32")],
        ["binding", binding("binding")],
        ["binding.matrices", binding("binding.matrices", "f32")],
        ["binding._meshWorld", binding("binding.mesh_world", "f32")],
        [
            "binding._meshWorldInverse",
            binding("binding.mesh_world_inverse", "f32"),
        ],
        ["binding.mesh", binding("binding.mesh")],
        ["binding.mesh.name", binding(`${mesh}.name`, "string")],
        [
            "binding.mesh.thinInstances",
            {
                ...binding(`${mesh}.thin_instances`),
                absentCpp: `!${mesh}.thin_instances`,
            },
        ],
        [
            "ti",
            {
                ...binding(`${mesh}.thin_instances`),
                absentCpp: `!${mesh}.thin_instances`,
            },
        ],
        [
            "ti._version",
            binding(
                `thin_instance_data(${mesh}.thin_instances).version`,
                "scalar",
            ),
        ],
        [
            "ti._dirtyMin",
            binding(
                `thin_instance_data(${mesh}.thin_instances).dirty_min`,
                "scalar",
            ),
        ],
        [
            "ti._dirtyMax",
            binding(
                `thin_instance_data(${mesh}.thin_instances).dirty_max`,
                "scalar",
            ),
        ],
        ["index", binding("index", "scalar")],
        ["count", binding("count", "scalar")],
        ["caller", binding("caller", "string")],
        ["matrix", binding("matrix", "f32")],
        ["rootMatrix", binding("root_matrix", "f32")],
    ]);
    const calls = new Map<string, (args: readonly string[]) => string>([
        ["Number.isInteger", (args) => `js::number_is_integer(${args[0]})`],
        [
            "multiplyMat4IntoBuffer",
            (args) => `hierarchy_multiply_into(${args.join(", ")})`,
        ],
        [
            "setThinInstanceCount",
            (args) => `set_thin_instance_count(engine, ${args.join(", ")})`,
        ],
        [
            "setHierarchyInstanceCount",
            (args) => `set_hierarchy_pool_count(engine, ${args.join(", ")})`,
        ],
        [
            "writeBindingMatrix",
            (args) => `write_hierarchy_binding_matrix(${args.join(", ")})`,
        ],
        [
            "markMatrixDirty",
            (args) =>
                `mark_hierarchy_binding_dirty(engine, ${args.join(", ")})`,
        ],
        [
            "assertActiveIndex",
            (args) => `assert_hierarchy_active_index(${args.join(", ")})`,
        ],
        [
            "binding.matrices.copyWithin",
            (args) =>
                `copy_hierarchy_binding_matrices(binding.matrices, ${args.join(", ")})`,
        ],
    ]);
    const body = (symbol: string): string => {
        const source = context.functionDeclaration(modulePath, symbol);
        const bindings = new Map(members);
        const parameters = new Set(
            source.declaration.parameters.map((parameter) =>
                soleBindingName(parameter.name),
            ),
        );
        for (const name of ["index", "count", "caller", "matrix", "rootMatrix"])
            if (!parameters.has(name)) bindings.delete(name);
        return lowerPinnedBody(
            source.file,
            source.declaration.body!.statements,
            {
                bindings,
                calls,
                returnValue: (node, lowerer) =>
                    node ? lowerer.expression(node) : "",
            },
        );
    };
    const multiply = lowerPinnedFunction(
        context,
        "src/math/multiply-mat4-into-buffer.ts",
        "multiplyMat4IntoBuffer",
        [
            {
                pinned: "dst",
                cpp: "dst",
                kind: "mat4",
                cppType: "Destination",
                mutableRecord: true,
            },
            { pinned: "d", cpp: "d", kind: "number" },
            { pinned: "a", cpp: "a", kind: "mat4", cppType: "Left" },
            { pinned: "i", cpp: "i", kind: "number" },
            { pinned: "b", cpp: "b", kind: "mat4", cppType: "Right" },
            { pinned: "j", cpp: "j", kind: "number" },
        ],
        {
            cppName: "hierarchy_multiply_into",
            returns: "void",
            templateParameters: [
                "typename Destination",
                "typename Left",
                "typename Right",
            ],
        },
    );
    return `// ${context.provenance(modulePath, "writeBindingMatrix,markMatrixDirty,assertActiveIndex,setHierarchyInstanceCount,addHierarchyInstance,setHierarchyInstanceMatrix,removeHierarchyInstance")}
${multiply}
// A typed-array handle copy retains its view identity, including for const or temporary receivers.
static js::F32Array copy_hierarchy_binding_matrices(js::F32Array matrices, double target, double start, double end) {
    js::array_copy_within(matrices, target, start, end);
    return matrices;
}
void write_hierarchy_binding_matrix(HierarchyInstancePoolRecord& pool, HierarchyInstancePoolBinding binding, double index, const std::array<float, 16>& root_matrix) {
${body("writeBindingMatrix")}
}
void mark_hierarchy_binding_dirty(Engine& engine, const HierarchyInstancePoolBinding& binding, double index) {
${body("markMatrixDirty")}
}
void assert_hierarchy_active_index(const HierarchyInstancePoolRecord& pool, double index, const std::string& caller) {
${body("assertActiveIndex")}
}
void set_hierarchy_pool_count(Engine& engine, HierarchyInstancePoolRecord& pool, double count) {
${body("setHierarchyInstanceCount")}
}
double add_hierarchy_pool_instance(Engine& engine, HierarchyInstancePoolRecord& pool, const std::array<float, 16>& matrix) {
${body("addHierarchyInstance")}
}
void set_hierarchy_pool_matrix(Engine& engine, HierarchyInstancePoolRecord& pool, double index, const std::array<float, 16>& matrix) {
${body("setHierarchyInstanceMatrix")}
}
void remove_hierarchy_pool_instance(Engine& engine, HierarchyInstancePoolRecord& pool, double index) {
${body("removeHierarchyInstance")}
}
`;
}
