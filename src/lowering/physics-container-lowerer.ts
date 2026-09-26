import ts from "typescript";
import type { LoweringContext } from "./context.js";
import {
    lowerPinnedFunction,
    type PinnedFunctionParameter,
} from "./pinned-function-lowerer.js";
import { lowerMat4DecomposeFull } from "./pinned-mat4-decompose.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import type {
    PinnedBinding,
    PinnedRecordShape,
} from "./pinned-numeric-lowerer.js";

const modulePath = "src/physics/havok.ts";

export function lowerPhysicsContainer(context: LoweringContext): {
    header: string;
    helpers: string;
    source: string;
} {
    const add = context.functionDeclaration(
        modulePath,
        "addPhysicsShapeChild",
    ).declaration;
    context.assertStatementInventory(
        add,
        add.body!.statements,
        "addPhysicsShapeChild",
        "optional transforms and the PAL tuple projection",
        [
            "variable statement",
            "variable statement",
            "variable statement",
            "expression statement",
        ],
    );
    const record = (lanes: readonly string[]): PinnedRecordShape => ({
        cpp: lanes.length === 4 ? "Vec4d" : "Vec3d",
        members: lanes.map((name) => ({
            name,
            read: (owner) =>
                new Map([["", { cpp: `${owner}.${name}`, type: "scalar" }]]),
            store: (value) => value,
        })),
    });
    const vec3 = record(["x", "y", "z"]),
        quat = record(["x", "y", "z", "w"]);
    const bindings = new Map<string, PinnedBinding>([
        [
            "translation",
            {
                cpp: "(*translation)",
                type: "opaque",
                record: vec3,
                nullish: "!translation",
            },
        ],
        [
            "rotation",
            {
                cpp: "(*rotation)",
                type: "opaque",
                record: quat,
                nullish: "!rotation",
            },
        ],
        [
            "scale",
            {
                cpp: "(*scale)",
                type: "opaque",
                record: vec3,
                nullish: "!scale",
            },
        ],
        ["container._hkShape", { cpp: "container.handle", type: "opaque" }],
        ["child._hkShape", { cpp: "child.handle", type: "opaque" }],
    ]);
    const direct = lowerPinnedBody(add.getSourceFile(), add.body!.statements, {
        bindings,
        calls: new Map(),
        statement(statement, numeric, indent) {
            if (!ts.isVariableStatement(statement)) return undefined;
            return statement.declarationList.declarations.map((declaration) => {
                const initializer = declaration.initializer;
                if (
                    !ts.isIdentifier(declaration.name) ||
                    !initializer ||
                    !ts.isBinaryExpression(initializer) ||
                    initializer.operatorToken.kind !==
                        ts.SyntaxKind.QuestionQuestionToken
                )
                    return context.contractError(
                        declaration,
                        "Expected an optional child transform record.",
                    );
                const shape = numeric.binding(initializer.left)?.record;
                if (!shape)
                    return context.contractError(
                        initializer,
                        "Unknown child transform record.",
                    );
                const value = numeric.expression(initializer);
                numeric.bindLocal(declaration.name, {
                    cpp: declaration.name.text,
                    type: "opaque",
                    record: shape,
                });
                numeric.bindPorts(
                    shape.members.map((member) => [
                        `${declaration.name.getText()}.${member.name}`,
                        {
                            cpp: `${declaration.name.getText()}.${member.name}`,
                            type: "scalar",
                        },
                    ]),
                    declaration.name,
                );
                return `${indent}const auto ${declaration.name.text} = ${value};`;
            });
        },
        expression(node, numeric) {
            if (ts.isObjectLiteralExpression(node)) {
                const lanes = node.properties.map((property) => {
                    if (
                        !ts.isPropertyAssignment(property) ||
                        !ts.isIdentifier(property.name)
                    )
                        return context.contractError(
                            property,
                            "Expected a numeric transform member.",
                        );
                    return [
                        property.name.text,
                        numeric.expression(property.initializer),
                    ] as const;
                });
                if (
                    !["x,y,z", "x,y,z,w"].includes(
                        lanes.map(([name]) => name).join(","),
                    )
                )
                    return context.contractError(
                        node,
                        "Expected a vector or quaternion transform record.",
                    );
                return `${lanes.length === 4 ? "Vec4d" : "Vec3d"}{${lanes.map(([, value]) => value).join(", ")}}`;
            }
            if (ts.isArrayLiteralExpression(node))
                return `std::array<double, ${node.elements.length}>{${node.elements.map((element) => numeric.expression(element)).join(", ")}}`;
            if (
                ts.isCallExpression(node) &&
                node.expression.getText() === "world._hknp.HP_Shape_AddChild"
            ) {
                const transform = node.arguments[2];
                if (
                    node.arguments.length !== 3 ||
                    !transform ||
                    !ts.isArrayLiteralExpression(transform) ||
                    transform.elements.length !== 3
                )
                    return context.contractError(
                        node,
                        "Expected shape handles and child transform tuple.",
                    );
                const [translation, rotation, scale] = transform.elements.map(
                    (element) => numeric.expression(element),
                );
                return `pal::physics_shape_add_child(${numeric.expression(node.arguments[0]!)}, ${numeric.expression(node.arguments[1]!)}, {${translation}, ${rotation}}, ${scale})`;
            }
            return undefined;
        },
    });
    const parameters: PinnedFunctionParameter[] = [
        ["world", "PhysicsWorld", "PhysicsWorldHandle"],
        ["container", "PhysicsShape", "PhysicsShape"],
        ["parentNode", "SceneNode", "PhysicsNodeRef"],
        ["child", "PhysicsShape", "PhysicsShape"],
        ["childNode", "SceneNode", "PhysicsNodeRef"],
    ].map(([pinned, annotation, cppType]) => ({
        pinned: pinned!,
        cpp: pinned!,
        kind: "record",
        annotation: annotation!,
        cppType: cppType!,
        binding: { cpp: pinned!, type: "opaque" },
    }));
    const fromParent = lowerPinnedFunction(
        context,
        modulePath,
        "addPhysicsShapeChildFromParent",
        parameters,
        {
            cppName: "pinned_add_physics_child_from_parent",
            returns: "void",
            leadingParameters: ["const Engine& engine"],
            memberBindings: new Map<string, PinnedBinding>([
                [
                    "parentNode.worldMatrix",
                    {
                        cpp: "physics_node_world(engine, parentNode)",
                        type: "f32",
                    },
                ],
                [
                    "childNode.worldMatrix",
                    {
                        cpp: "physics_node_world(engine, childNode)",
                        type: "f32",
                    },
                ],
            ]),
            nullableMatrixCalls: new Set(["invertMat4"]),
            matrixCalls: new Set(["multiplyMat4"]),
            recordCalls: new Map([
                ["decomposeMat4", ["translation", "rotation", "scale"]],
            ]),
            calls: new Map([
                ["invertMat4", (args) => `mat4_invert(${args[0]})`],
                [
                    "multiplyMat4",
                    (args) => `physics_matrix_product(${args.join(", ")})`,
                ],
                [
                    "decomposeMat4",
                    (args) => `pinned_parent_mat4_decompose(${args[0]})`,
                ],
                [
                    "addPhysicsShapeChild",
                    (args) =>
                        `add_physics_shape_child(${args[0]}, ${args[1]}, ${args[2]}, ` +
                        `Vec3d{${args[3]}.x, ${args[3]}.y, ${args[3]}.z}, ` +
                        `Vec4d{${args[4]}.x, ${args[4]}.y, ${args[4]}.z, ${args[4]}.w}, ` +
                        `Vec3d{${args[5]}.x, ${args[5]}.y, ${args[5]}.z})`,
                ],
            ]),
        },
    );
    return {
        header: `
PhysicsShape create_physics_container_shape(PhysicsWorldHandle world);
void add_physics_shape_child(PhysicsWorldHandle world, PhysicsShape container, PhysicsShape child,
    js::Nullable<Vec3d> translation = {}, js::Nullable<Vec4d> rotation = {}, js::Nullable<Vec3d> scale = {});
void add_physics_shape_child_from_parent(PhysicsWorldHandle world, PhysicsShape container,
    PhysicsNodeRef parent, PhysicsShape child, PhysicsNodeRef node);
`,
        helpers: `
${lowerMat4DecomposeFull(context)}
${fromParent}
`,
        source: `
// ${context.provenance(modulePath, "addPhysicsShapeChild")}
void add_physics_shape_child([[maybe_unused]] PhysicsWorldHandle world, PhysicsShape container, PhysicsShape child,
    js::Nullable<Vec3d> translation, js::Nullable<Vec4d> rotation, js::Nullable<Vec3d> scale) {
${direct}
}
PhysicsShape create_physics_container_shape(PhysicsWorldHandle world) {
    static_cast<void>(physics_world_record(world));
    return PhysicsShape{pal::physics_shape_create_container()};
}
void add_physics_shape_child_from_parent(PhysicsWorldHandle world, PhysicsShape container,
    PhysicsNodeRef parent, PhysicsShape child, PhysicsNodeRef node) {
    pinned_add_physics_child_from_parent(*physics_world_record(world).engine, world, container, parent, child, node);
}
`,
    };
}
