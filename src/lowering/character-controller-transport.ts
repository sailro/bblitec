import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { type ReferenceSchema, type ReferenceValue, PinnedReferenceLowerer, referenceTuple } from "./pinned-reference-lowerer.js";

export const queryResultType = referenceTuple(["number", "QueryPoint", "QueryPoint"]);
export const massPropertiesType = referenceTuple(["number[]", "number", "number[]", "number[]"]);

/** HP calls carry opaque handles and native collector storage. Numeric contact,
 * manifold and body-kinematics expressions remain ordinary pinned AST lowering. */
export function characterTransportSchema(context: LoweringContext): Pick<ReferenceSchema, "expression" | "statement"> {
    const bodyArgument = (expression: ts.Expression, lowerer: PinnedReferenceLowerer): ReferenceValue => {
        if (!ts.isPropertyAccessExpression(expression) || expression.name.text !== "_hkBody") return context.contractError(expression, "Character PAL call requires the body's Havok handle.");
        const body = lowerer.expression(expression.expression);
        if (body.type !== "PhysicsBody") return context.contractError(expression, "Character PAL body has an unrepresented owner.");
        return body;
    };
    const collector = (expression: ts.Expression): string => {
        const path = expression.getText(expression.getSourceFile());
        if (path === "this._startCollector") return "_start_hits()";
        if (path === "this._castCollector") return "_cast_hits()";
        return context.contractError(expression, "Character query must use its owned collector.");
    };
    return {
        statement(node, _lowerer, indent) {
            if (!ts.isVariableStatement(node) || node.declarationList.declarations.length !== 1) return;
            const declaration = node.declarationList.declarations[0]!;
            if (!ts.isIdentifier(declaration.name) || declaration.name.text !== "hknp") return;
            context.assertStatementShapes(node, [node], "const hknp = this._world._hknp;", "character solver module binding");
            return `${indent}// The solver module is the native PAL.`;
        },
        expression(node, _expected, lowerer) {
            if (ts.isPropertyAccessExpression(node)) {
                if (node.name.text === "motionType") {
                    const body = lowerer.expression(node.expression);
                    if (body.type === "PhysicsBody") return node.questionDotToken
                        ? { cpp: `(${body.cpp} ? std::optional<double>{_body_motion_type(${body.cpp})} : std::nullopt)`, type: "optional:number" }
                        : { cpp: `_body_motion_type(${body.cpp})`, type: "number" };
                }
                if (node.name.text === "worldMatrix" && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "node") {
                    const body = lowerer.expression(node.expression.expression);
                    if (body.type === "PhysicsBody") return { cpp: `_body_world_matrix(${body.cpp})`, type: "number[]" };
                }
            }
            if (ts.isElementAccessExpression(node) && ts.isNumericLiteral(node.argumentExpression)) {
                if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "_hkBody" && node.argumentExpression.text === "0")
                    return { cpp: `_body_identity(${bodyArgument(node.expression, lowerer).cpp})`, type: "optional:number" };
                if (ts.isCallExpression(node.expression) && node.argumentExpression.text === "1" && ts.isPropertyAccessExpression(node.expression.expression)) {
                    const call = node.expression, path = call.expression.getText(call.getSourceFile());
                    const name = (call.expression as ts.PropertyAccessExpression).name.text;
                    if (!path.startsWith("hknp.HP_") && !path.startsWith("this._world._hknp.HP_")) return;
                    if (name === "HP_QueryCollector_GetNumHits" && call.arguments.length === 1)
                        return { cpp: `static_cast<double>(${collector(call.arguments[0]!)}.size())`, type: "number" };
                    if (["HP_QueryCollector_GetShapeCastResult", "HP_QueryCollector_GetShapeProximityResult"].includes(name) && call.arguments.length === 2)
                        return { cpp: `${collector(call.arguments[0]!)}.at(js::array_index(${lowerer.expression(call.arguments[1]!).cpp}))`, type: queryResultType };
                    const bodyGetters = new Map([
                        ["HP_Body_GetMassProperties", ["_mass_properties", massPropertiesType]],
                        ["HP_Body_GetAngularVelocity", ["_angular_velocity", "number[]"]],
                        ["HP_Body_GetLinearVelocity", ["_linear_velocity", "number[]"]],
                    ]);
                    const getter = bodyGetters.get(name);
                    if (getter && call.arguments.length === 1) return { cpp: `${getter[0]}(${bodyArgument(call.arguments[0]!, lowerer).cpp})`, type: getter[1]! };
                }
                const owner = lowerer.expression(node.expression);
                if (owner.type === "QueryPoint") {
                    const field = new Map([["0", ["identity", "number[]"]], ["3", ["position", "number[]"]], ["4", ["normal", "number[]"]]]).get(node.argumentExpression.text);
                    if (field) return { cpp: `${owner.cpp}->${field[0]}`, type: field[1]! };
                }
            }
            if (ts.isCallExpression(node)) {
                const path = node.expression.getText(node.getSourceFile());
                if (path === "worldStepSeconds" && node.arguments.length === 1 && node.arguments[0]!.getText(node.getSourceFile()) === "this._world")
                    return { cpp: "_world_step_seconds()", type: "number" };
                if (path === "hknp.HP_Body_ApplyImpulse" && node.arguments.length === 3)
                    return { cpp: `_apply_impulse(${bodyArgument(node.arguments[0]!, lowerer).cpp}, ${lowerer.expression(node.arguments[1]!, "number[]").cpp}, ${lowerer.expression(node.arguments[2]!, "number[]").cpp})`, type: "void" };
            }
        },
    };
}

/** Collector allocation and packed HP query slots become owned PAL buffers.
 * Shape and ignored-body handles retain the controller's own identities. */
export function lowerCharacterCollectorCasts(context: LoweringContext, declaration: ts.MethodDeclaration, lowerer: PinnedReferenceLowerer): string {
    context.assertStatementShapes(declaration, declaration.body!.statements, [
        "const hknp = this._world._hknp;",
        "const hkWorld = this._world._hkWorld;",
        "const shapeHandle = this._shape._hkShape;",
        "const startNative = [startPos.x, startPos.y, startPos.z];",
        "const orientation = [this._orientation.x, this._orientation.y, this._orientation.z, this._orientation.w];",
        "const ignoreSelf = [this._body._hkBody[0]];",
        "if (!castOnly) { const proxQuery = [shapeHandle, startNative, orientation, this.keepDistance + this.keepContactTolerance, false, ignoreSelf]; hknp.HP_World_ShapeProximityWithCollector(hkWorld, this._startCollector, proxQuery); }",
        "const castQuery = [shapeHandle, orientation, startNative, [endPos.x, endPos.y, endPos.z], false, ignoreSelf];",
        "hknp.HP_World_ShapeCastWithCollector(hkWorld, this._castCollector, castQuery);",
    ].join("\n"), "character collector query assembly and order");
    const source = declaration.body!.statements;
    const initializer = (statement: ts.Statement) => (statement as ts.VariableStatement).declarationList.declarations[0]!.initializer!;
    const proximity = initializer(((source[6] as ts.IfStatement).thenStatement as ts.Block).statements[0]!) as ts.ArrayLiteralExpression;
    const cast = initializer(source[7]!) as ts.ArrayLiteralExpression;
    return `    const auto start = ${lowerer.expression(initializer(source[3]!), "number[]").cpp};
    const auto orientation = ${lowerer.expression(initializer(source[4]!), "number[]").cpp};
    if (${lowerer.expression((source[6] as ts.IfStatement).expression).cpp}) {
        _collect_proximity(start, orientation, ${lowerer.expression(proximity.elements[3]!).cpp}, ${lowerer.expression(proximity.elements[4]!).cpp});
    }
    _collect_cast(orientation, start, ${lowerer.expression(cast.elements[3]!, "number[]").cpp}, ${lowerer.expression(cast.elements[4]!).cpp});`;
}
