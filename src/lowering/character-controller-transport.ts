import {
    type RecordShape,
    recordScalars,
    recordOf,
    arrayOf,
    optionalOf,
    tupleOf,
} from "./record-shapes.js";
import ts from "typescript";
import type { LoweringContext } from "./context.js";
import {
    type CharacterKernelLowerer,
    type KernelSchema,
    type KernelValue,
} from "./character-kernel-lowerer.js";

export const queryResultType = tupleOf([
    recordScalars.number,
    recordOf("QueryPoint"),
    recordOf("QueryPoint"),
]);
export const massPropertiesType = tupleOf([
    arrayOf(recordScalars.number),
    recordScalars.number,
    arrayOf(recordScalars.number),
    arrayOf(recordScalars.number),
]);

/** HP calls carry opaque handles and native collector storage. Numeric contact,
 * manifold and body-kinematics expressions remain ordinary pinned AST lowering. */
export function characterTransportSchema(
    context: LoweringContext,
): Pick<KernelSchema, "expression" | "statement"> {
    const bodyArgument = (
        expression: ts.Expression,
        lowerer: CharacterKernelLowerer,
    ): KernelValue => {
        const body = lowerer.value(expression);
        if (body.type.kind !== "record" || body.type.name !== "NativeBody")
            return context.contractError(
                expression,
                "Character PAL call requires a represented native body handle.",
            );
        return body;
    };
    const collector = (expression: ts.Expression): string => {
        const path = expression.getText(expression.getSourceFile());
        if (path === "this._startCollector") return "_start_hits()";
        if (path === "this._castCollector") return "_cast_hits()";
        return context.contractError(
            expression,
            "Character query must use its owned collector.",
        );
    };
    return {
        statement(node, _lowerer, indent) {
            if (
                !ts.isVariableStatement(node) ||
                node.declarationList.declarations.length !== 1
            )
                return;
            const declaration = node.declarationList.declarations[0]!;
            if (
                !ts.isIdentifier(declaration.name) ||
                declaration.name.text !== "hknp"
            )
                return;
            if (
                declaration.initializer?.getText(
                    declaration.getSourceFile(),
                ) === "world._hknp"
            )
                context.assertStatementShapes(
                    node,
                    [node],
                    "const hknp = world._hknp;",
                    "character constructor solver binding",
                );
            else
                context.assertStatementShapes(
                    node,
                    [node],
                    "const hknp = this._world._hknp;",
                    "character solver module binding",
                );
            return `${indent}// The solver module is the native PAL.`;
        },
        expression(node, _expected, lowerer) {
            if (ts.isPropertyAccessExpression(node)) {
                if (
                    node.getText(node.getSourceFile()) === "this._world._bodies"
                )
                    return {
                        cpp: "_world_bodies()",
                        type: arrayOf(recordOf("PhysicsBody")),
                    };
                if (node.name.text === "_hkBody") {
                    const body = lowerer.value(node.expression);
                    if (
                        body.type.kind === "record" &&
                        body.type.name === "PhysicsBody"
                    )
                        return {
                            cpp: `_native_body(${body.cpp})`,
                            type: recordOf("NativeBody"),
                        };
                }
                if (node.name.text === "motionType") {
                    const body = lowerer.value(node.expression);
                    if (
                        body.type.kind === "record" &&
                        body.type.name === "PhysicsBody"
                    )
                        return node.questionDotToken
                            ? {
                                  cpp: `(${body.cpp} ? std::optional<double>{_body_motion_type(${body.cpp})} : std::nullopt)`,
                                  type: optionalOf(recordScalars.number),
                              }
                            : {
                                  cpp: `_body_motion_type(${body.cpp})`,
                                  type: recordScalars.number,
                              };
                }
                if (
                    node.name.text === "worldMatrix" &&
                    ts.isPropertyAccessExpression(node.expression) &&
                    node.expression.name.text === "node"
                ) {
                    const body = lowerer.value(node.expression.expression);
                    if (
                        body.type.kind === "record" &&
                        body.type.name === "PhysicsBody"
                    )
                        return {
                            cpp: `_body_world_matrix(${body.cpp})`,
                            type: arrayOf(recordScalars.number),
                        };
                }
            }
            if (
                ts.isElementAccessExpression(node) &&
                ts.isNumericLiteral(node.argumentExpression)
            ) {
                if (
                    ts.isPropertyAccessExpression(node.expression) &&
                    node.expression.name.text === "_hkBody" &&
                    node.argumentExpression.text === "0"
                )
                    return {
                        cpp: `_body_identity(${lowerer.value(node.expression.expression).cpp})`,
                        type: optionalOf(recordScalars.number),
                    };
                if (
                    ts.isCallExpression(node.expression) &&
                    node.argumentExpression.text === "1" &&
                    ts.isPropertyAccessExpression(node.expression.expression)
                ) {
                    const call = node.expression,
                        path = call.expression.getText(call.getSourceFile());
                    const name = (
                        call.expression as ts.PropertyAccessExpression
                    ).name.text;
                    if (
                        !path.startsWith("hknp.HP_") &&
                        !path.startsWith("this._world._hknp.HP_")
                    )
                        return;
                    if (
                        name === "HP_QueryCollector_Create" &&
                        call.arguments.length === 1
                    )
                        return {
                            cpp: `_create_collector(${lowerer.value(call.arguments[0]!).cpp})`,
                            type: recordOf("QueryCollector"),
                        };
                    if (
                        name === "HP_QueryCollector_GetNumHits" &&
                        call.arguments.length === 1
                    )
                        return {
                            cpp: `static_cast<double>(${collector(call.arguments[0]!)}.size())`,
                            type: recordScalars.number,
                        };
                    if (
                        [
                            "HP_QueryCollector_GetShapeCastResult",
                            "HP_QueryCollector_GetShapeProximityResult",
                        ].includes(name) &&
                        call.arguments.length === 2
                    )
                        return {
                            cpp: `${collector(call.arguments[0]!)}.at(js::array_index(${lowerer.value(call.arguments[1]!).cpp}))`,
                            type: queryResultType,
                        };
                    const bodyGetters = new Map<
                        string,
                        readonly [string, RecordShape]
                    >([
                        [
                            "HP_Body_GetMassProperties",
                            ["_mass_properties", massPropertiesType],
                        ],
                        [
                            "HP_Body_GetAngularVelocity",
                            [
                                "_angular_velocity",
                                arrayOf(recordScalars.number),
                            ],
                        ],
                        [
                            "HP_Body_GetLinearVelocity",
                            ["_linear_velocity", arrayOf(recordScalars.number)],
                        ],
                    ]);
                    const getter = bodyGetters.get(name);
                    if (getter && call.arguments.length === 1)
                        return {
                            cpp: `${getter[0]}(${bodyArgument(call.arguments[0]!, lowerer).cpp})`,
                            type: getter[1],
                        };
                }
                const owner = lowerer.value(node.expression);
                if (
                    owner.type.kind === "record" &&
                    owner.type.name === "QueryPoint"
                ) {
                    const field = new Map<
                        string,
                        readonly [string, RecordShape]
                    >([
                        ["0", ["identity", arrayOf(recordScalars.number)]],
                        ["3", ["position", arrayOf(recordScalars.number)]],
                        ["4", ["normal", arrayOf(recordScalars.number)]],
                    ]).get(node.argumentExpression.text);
                    if (field)
                        return {
                            cpp: `${owner.cpp}->${field[0]}`,
                            type: field[1],
                            borrowed: "mutable",
                        };
                }
            }
            if (ts.isCallExpression(node)) {
                const path = node.expression.getText(node.getSourceFile());
                const thin = new Map<string, readonly [string, RecordShape]>([
                    [
                        "this._world._thin?.resolve",
                        [
                            "_thin_resolve",
                            optionalOf(
                                tupleOf([
                                    recordOf("PhysicsBody"),
                                    recordOf("NativeBody"),
                                    recordScalars.number,
                                ]),
                            ),
                        ],
                    ],
                    ["this._world._thin?.com", ["_thin_com", recordOf("Vec3")]],
                    [
                        "this._world._thin?.matrix",
                        [
                            "_thin_matrix",
                            optionalOf(arrayOf(recordScalars.number)),
                        ],
                    ],
                ]).get(path);
                if (thin)
                    return {
                        cpp: `${thin[0]}(${node.arguments.map((argument) => lowerer.value(argument).cpp).join(", ")})`,
                        type: thin[1],
                    };
                if (
                    path === "worldStepSeconds" &&
                    node.arguments.length === 1 &&
                    node.arguments[0]!.getText(node.getSourceFile()) ===
                        "this._world"
                )
                    return {
                        cpp: "_world_step_seconds()",
                        type: recordScalars.number,
                    };
                if (
                    path === "hknp.HP_Body_ApplyImpulse" &&
                    node.arguments.length === 3
                )
                    return {
                        cpp: `_apply_impulse(${bodyArgument(node.arguments[0]!, lowerer).cpp}, ${lowerer.value(node.arguments[1]!, arrayOf(recordScalars.number)).cpp}, ${lowerer.value(node.arguments[2]!, arrayOf(recordScalars.number)).cpp})`,
                        type: recordScalars.void,
                    };
                if (
                    [
                        "hknp.HP_QueryCollector_Release",
                        "this._world._hknp.HP_QueryCollector_Release",
                    ].includes(path) &&
                    node.arguments.length === 1
                ) {
                    collector(node.arguments[0]!);
                    return {
                        cpp: `_release_collector(${lowerer.value(node.arguments[0]!).cpp})`,
                        type: recordScalars.void,
                    };
                }
                if (
                    [
                        "hknp.HP_Shape_Release",
                        "this._world._hknp.HP_Shape_Release",
                    ].includes(path) &&
                    node.arguments.length === 1
                ) {
                    const handle = node.arguments[0]!;
                    if (
                        !ts.isPropertyAccessExpression(handle) ||
                        handle.name.text !== "_hkShape"
                    )
                        return context.contractError(
                            handle,
                            "Character release requires its shape handle.",
                        );
                    const shape = lowerer.value(handle.expression);
                    if (
                        shape.type.kind !== "record" ||
                        shape.type.name !== "PhysicsShape"
                    )
                        return context.contractError(
                            handle,
                            "Character shape release has an unrepresented owner.",
                        );
                    return {
                        cpp: `_release_shape(${shape.cpp})`,
                        type: recordScalars.void,
                    };
                }
            }
        },
    };
}

/** Collector allocation and packed HP query slots become owned PAL buffers.
 * Shape and ignored-body handles retain the controller's own identities. */
export function lowerCharacterCollectorCasts(
    context: LoweringContext,
    declaration: ts.MethodDeclaration,
    lowerer: CharacterKernelLowerer,
): string {
    context.assertStatementShapes(
        declaration,
        declaration.body!.statements,
        [
            "const hknp = this._world._hknp;",
            "const hkWorld = this._world._hkWorld;",
            "const shapeHandle = this._shape._hkShape;",
            "const startNative = [startPos.x, startPos.y, startPos.z];",
            "const orientation = [this._orientation.x, this._orientation.y, this._orientation.z, this._orientation.w];",
            "const ignoreSelf = [this._body._hkBody[0]];",
            "if (!castOnly) { const proxQuery = [shapeHandle, startNative, orientation, this.keepDistance + this.keepContactTolerance, false, ignoreSelf]; hknp.HP_World_ShapeProximityWithCollector(hkWorld, this._startCollector, proxQuery); }",
            "const castQuery = [shapeHandle, orientation, startNative, [endPos.x, endPos.y, endPos.z], false, ignoreSelf];",
            "hknp.HP_World_ShapeCastWithCollector(hkWorld, this._castCollector, castQuery);",
        ].join("\n"),
        "character collector query assembly and order",
    );
    const source = declaration.body!.statements;
    const initializer = (statement: ts.Statement) =>
        (statement as ts.VariableStatement).declarationList.declarations[0]!
            .initializer!;
    const proximity = initializer(
        ((source[6] as ts.IfStatement).thenStatement as ts.Block)
            .statements[0]!,
    ) as ts.ArrayLiteralExpression;
    const cast = initializer(source[7]!) as ts.ArrayLiteralExpression;
    return `    const auto start = ${lowerer.value(initializer(source[3]!), arrayOf(recordScalars.number)).cpp};
    const auto orientation = ${lowerer.value(initializer(source[4]!), arrayOf(recordScalars.number)).cpp};
    if (${lowerer.value((source[6] as ts.IfStatement).expression).cpp}) {
        _collect_proximity(start, orientation, ${lowerer.value(proximity.elements[3]!).cpp}, ${lowerer.value(proximity.elements[4]!).cpp});
    }
    _collect_cast(orientation, start, ${lowerer.value(cast.elements[3]!, arrayOf(recordScalars.number)).cpp}, ${lowerer.value(cast.elements[4]!).cpp});`;
}
