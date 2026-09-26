import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import { absentBinding, type PinnedBinding } from "./pinned-numeric-lowerer.js";

/** Native shape handles and keyed ownership adapt the pin's optional advanced seam. */
export function lowerPhysicsThinAdvanced(context: LoweringContext): string {
    const module = "src/physics/havok-thin-instance-advanced.ts";
    const { file, declaration } = context.functionDeclaration(
        module,
        "enableHavokThinInstanceAdvancedPhysics",
    );
    const assignment = context
        .findNodes(declaration, ts.isBinaryExpression)
        .find((node) => node.left.getText(file) === "world._thinAdvanced");
    if (!assignment || !ts.isObjectLiteralExpression(assignment.right))
        return context.contractError(
            declaration,
            "Expected the advanced thin context.",
        );
    const contextRecord = assignment.right;
    const method = (name: string) => {
        const member = contextRecord.properties.find(
            (property) => property.name?.getText(file) === name,
        );
        if (!member || !ts.isMethodDeclaration(member) || !member.body)
            return context.contractError(
                declaration,
                `Expected advanced method ${name}.`,
            );
        return member.body.statements;
    };
    const binding = (
        cpp: string,
        type: PinnedBinding["type"] = "opaque",
    ): PinnedBinding => ({ cpp, type });
    const massSource = context.functionDeclaration(
        "src/physics/havok-mass-properties.ts",
        "buildNativeMassProperties",
    );
    const massStatements = massSource.declaration.body!.statements;
    const overrides = lowerPinnedBody(
        massSource.file,
        massStatements.slice(5),
        {
            bindings: new Map([
                [
                    "centerOfMass",
                    {
                        ...binding("(*properties.center_of_mass)", "vec3"),
                        absentCpp: "!properties.center_of_mass",
                    },
                ],
                [
                    "mass",
                    {
                        ...binding("*properties.mass", "scalar"),
                        absentCpp: "!properties.mass",
                    },
                ],
                [
                    "inertia",
                    {
                        ...binding("(*properties.inertia)", "vec3"),
                        absentCpp: "!properties.inertia",
                    },
                ],
                ["inertiaOrientation", absentBinding()],
                ["result", binding("result")],
            ]),
            calls: new Map(),
            statement(statement, numeric, indent) {
                if (
                    !ts.isExpressionStatement(statement) ||
                    !ts.isBinaryExpression(statement.expression)
                )
                    return undefined;
                const assignment = statement.expression;
                if (
                    !ts.isElementAccessExpression(assignment.left) ||
                    assignment.left.expression.getText() !== "result"
                )
                    return undefined;
                const index = assignment.left.argumentExpression.getText();
                if (index === "1")
                    return [
                        `${indent}result.mass = ${numeric.expression(assignment.right)};`,
                    ];
                if (
                    (index === "0" || index === "2") &&
                    ts.isArrayLiteralExpression(assignment.right)
                ) {
                    const lanes = assignment.right.elements.map((lane) =>
                        numeric.expression(lane),
                    );
                    return [
                        `${indent}result.${index === "0" ? "center_of_mass" : "inertia"} = {${lanes.map((lane) => (index === "2" ? `(${lane}) * result.mass` : lane)).join(", ")}};`,
                    ];
                }
                return undefined;
            },
            returnValue: (expression, numeric) =>
                expression ? numeric.expression(expression) : "",
        },
    );
    context.assertStatementShapes(
        massSource.declaration,
        massStatements.slice(0, 5),
        `
        const ok = raw.Result?.RESULT_OK ?? 0;
        const shape = raw.HP_Body_GetShape(handle);
        const shapeMass = shape[0] === ok ? raw.HP_Shape_BuildMassProperties(shape[1]) : null;
        const result: NativeMassProperties = shapeMass?.[0] === ok ? shapeMass[1] : [[0, 0, 0], 1, [fallbackInertia, fallbackInertia, fallbackInertia], [0, 0, 0, 1]];
        const { centerOfMass, mass, inertia, inertiaOrientation } = properties;
    `,
        "Mass-property transport and tuple storage",
    );
    const setShapes = lowerPinnedBody(file, method("setShapes"), {
        bindings: new Map([
            [
                "handles.length",
                binding("static_cast<double>(state.handles.size())", "scalar"),
            ],
            ["scales", binding("state.scales", "f64-buffer")],
            ["shape", binding("shape")],
            [
                "instanceShape",
                {
                    ...binding("instance_shape"),
                    absentCpp: "instance_shape.value == 0",
                },
            ],
            ["key", binding("key")],
            ["result", binding("result", "scalar")],
        ]),
        calls: new Map<string, (args: readonly string[]) => string>([
            [
                "scaledShapes.get",
                (args) => `thin_find_scaled_shape(scaled_shapes, ${args[0]})`,
            ],
            [
                "scaledShapes.set",
                (args) => `scaled_shapes.insert_or_assign(${args.join(", ")})`,
            ],
            [
                "raw.HP_Body_SetShape",
                (args) =>
                    `(pal::physics_body_set_shape(${args.join(", ")}), 0.0)`,
            ],
            ["releaseShapes", () => "state.scaled_shapes.clear()"],
            [
                "shapesByHandles.set",
                () => "state.scaled_shapes = std::move(scaled_shapes)",
            ],
        ]),
        statement(statement, numeric, indent) {
            if (!ts.isVariableStatement(statement)) return undefined;
            const local = statement.declarationList.declarations[0]!;
            const name = local.name.getText(file);
            if (name === "scaledShapes") {
                context.assertExpressionShape(
                    local.initializer!,
                    "new Map<string, any>()",
                    "Scaled shape map allocation",
                );
                return [`${indent}ThinScaledShapes scaled_shapes;`];
            }
            if (name === "result") return [`${indent}double result = 0.0;`];
            if (name === "instanceShape")
                return [
                    `${indent}auto instance_shape = ${numeric.expression(local.initializer!)};`,
                ];
            if (name === "key") {
                const key = local.initializer!;
                if (
                    !ts.isTemplateExpression(key) ||
                    key.templateSpans.length !== 3
                )
                    return context.contractError(
                        key,
                        "Expected three scale key components.",
                    );
                return [
                    `${indent}const std::array<double, 3> key{${key.templateSpans.map((span) => numeric.expression(span.expression)).join(", ")}};`,
                ];
            }
            return undefined;
        },
        expression(expression, numeric) {
            if (
                ts.isElementAccessExpression(expression) &&
                expression.expression.getText(file) === "handles"
            )
                return `state.handles.at(static_cast<std::size_t>(${numeric.expression(expression.argumentExpression)}))`;
            if (
                context.expressionMatchesShape(
                    expression,
                    "raw.HP_Shape_CreateContainer()[1]",
                )
            )
                return "pal::physics_shape_create_container()";
            if (
                ts.isCallExpression(expression) &&
                expression.expression.getText(file) === "raw.HP_Shape_AddChild"
            ) {
                const transform = expression.arguments[2];
                if (
                    !transform ||
                    !ts.isArrayLiteralExpression(transform) ||
                    transform.elements.length !== 3
                )
                    return context.contractError(
                        expression,
                        "Expected scaled child transform tuple.",
                    );
                const parts = transform.elements.map((part) => {
                    if (!ts.isArrayLiteralExpression(part))
                        return context.contractError(
                            part,
                            "Expected transform lanes.",
                        );
                    return `{${part.elements.map((lane) => numeric.expression(lane)).join(", ")}}`;
                });
                return `pal::physics_shape_add_child(${numeric.expression(expression.arguments[0]!)}, ${numeric.expression(expression.arguments[1]!)}, {${parts[0]}, ${parts[1]}}, ${parts[2]})`;
            }
            // These calls adapt ownership maps; arguments identifying the already-selected state carry no values.
            if (
                ts.isCallExpression(expression) &&
                expression.expression.getText(file) === "releaseShapes"
            )
                return "state.scaled_shapes.clear()";
            if (
                ts.isCallExpression(expression) &&
                expression.expression.getText(file) === "shapesByHandles.set"
            )
                return "state.scaled_shapes = std::move(scaled_shapes)";
            return undefined;
        },
        returnValue: (expression, numeric) =>
            expression ? numeric.expression(expression) : "",
    });
    const mass = lowerPinnedBody(file, method("mass"), {
        bindings: new Map([
            ["body._massPropertiesTransform", absentBinding()],
            [
                "handles.length",
                binding("static_cast<double>(state.handles.size())", "scalar"),
            ],
            ["properties", binding("properties")],
            ["fallbackInertia", binding("fallback_inertia", "scalar")],
            ["massProperties", binding("mass_properties")],
        ]),
        calls: new Map<string, (args: readonly string[]) => string>([
            [
                "raw.HP_Body_SetMassProperties",
                (args) =>
                    `pal::physics_body_set_mass_properties(${args.join(", ")})`,
            ],
        ]),
        statement(statement, numeric, indent) {
            if (!ts.isVariableStatement(statement)) return undefined;
            const local = statement.declarationList.declarations[0]!;
            if (local.name.getText(file) !== "massProperties") return undefined;
            context.assertExpressionShape(
                local.initializer!,
                "buildNativeMassProperties(raw, handles[index], properties, fallbackInertia)",
                "Per-instance mass construction",
            );
            const index = context
                .findNodes(local.initializer!, ts.isIdentifier)
                .find((node) => node.text === "index")!;
            return [
                `${indent}const auto mass_properties = physics_native_mass_properties(state.handles.at(static_cast<std::size_t>(${numeric.expression(index)})), properties, fallback_inertia);`,
            ];
        },
        expression(expression, numeric) {
            if (
                ts.isElementAccessExpression(expression) &&
                expression.expression.getText(file) === "handles"
            )
                return `state.handles.at(static_cast<std::size_t>(${numeric.expression(expression.argumentExpression)}))`;
            return undefined;
        },
    });
    return `
pal::PhysicsMassProperties physics_native_mass_properties(pal::PhysicsBodyHandle body, const PhysicsMassPropertyOverrides& properties, double fallback_inertia) {
    const auto shape = pal::physics_body_get_shape(body);
    const double mass = properties.mass ? *properties.mass : shape.value ? pal::physics_shape_default_mass(shape) : 1.0;
    auto result = shape.value ? pal::physics_shape_build_mass_properties(shape, mass) : pal::PhysicsMassProperties{{0, 0, 0}, 1, {fallback_inertia, fallback_inertia, fallback_inertia}, {0, 0, 0, 1}};
${overrides}
}
pal::PhysicsShapeHandle thin_find_scaled_shape(const ThinScaledShapes& shapes, const std::array<double, 3>& key) {
    const auto found = shapes.find(key);
    return found == shapes.end() ? pal::PhysicsShapeHandle{} : found->second;
}
double thin_set_shapes(ThinPhysicsState& state, pal::PhysicsShapeHandle shape) {
${setShapes}
}
void thin_set_mass(ThinPhysicsState& state, const PhysicsMassPropertyOverrides& properties, double fallback_inertia) {
${mass}
}`;
}
