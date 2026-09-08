import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { PinnedNumericLowerer, type PinnedBinding } from "./pinned-numeric-lowerer.js";
import { pinnedNumericMathCallsWithHypot } from "./pinned-operators.js";

const module = "src/physics/havok.ts";

/** Babylon selects axes and anchor defaults; the PAL supplies the joint solver. */
export function lowerPhysicsConstraints(context: LoweringContext): { header: string; source: string } {
    const factory = context.functionDeclaration(module, "createPhysicsConstraint");
    context.assertExpressionShape(factory.declaration.parameters[4]!.initializer!, "{}", "constraint options default");
    context.assertExpressionShape(factory.declaration.parameters[5]!.initializer!, "[]", "constraint limits default");
    context.assertStatementShapes(factory.declaration, factory.declaration.body!.statements, `
        const hknp = world._hknp;
        const joint = hknp.HP_Constraint_Create()[1];
        hknp.HP_Constraint_SetParentBody(joint, bodyA._hkBody);
        hknp.HP_Constraint_SetChildBody(joint, bodyB._hkBody);
        const pivotA = options.pivotA ?? ZERO_VEC3;
        const pivotB = options.pivotB ?? ZERO_VEC3;
        const axisA = options.axisA ?? X_AXIS;
        const axisB = options.axisB ?? X_AXIS;
        const perpAxisA = options.perpAxisA ?? normalTo(axisA);
        const perpAxisB = options.perpAxisB ?? normalTo(axisB);
        hknp.HP_Constraint_SetAnchorInParent(joint, vec3Array(pivotA), vec3Array(axisA), vec3Array(perpAxisA));
        hknp.HP_Constraint_SetAnchorInChild(joint, vec3Array(pivotB), vec3Array(axisB), vec3Array(perpAxisB));
        configureConstraintAxes(hknp, joint, type, options, limits);
        hknp.HP_Constraint_SetCollisionsEnabled(joint, !!options.collision);
        hknp.HP_Constraint_SetEnabled(joint, true);
        return { _hkConstraint: joint, _isDisposed: false, bodyA, bodyB, type, options: { ...options, axisA, axisB, perpAxisA, perpAxisB }, limits };
    `, "constraint construction, anchor order, configuration and enabled ownership");
    for (const [name, expression] of [["ZERO_VEC3", "{x:0,y:0,z:0}"], ["X_AXIS", "{x:1,y:0,z:0}"]]) {
        context.assertExpressionShape(context.variableInitializer(factory.file, name!), expression!, `${name} constraint default`);
    }
    const array = context.functionDeclaration(module, "vec3Array").declaration;
    context.assertStatementShapes(array, array.body!.statements, "return [v.x,v.y,v.z];", "constraint anchor array order");
    const configure = context.functionDeclaration(module, "configureConstraintAxes").declaration;
    const statements = configure.body!.statements;
    context.assertStatementShapes(configure, statements.slice(0, 4), `
        const axis = hknp.ConstraintAxis;
        const mode = hknp.ConstraintAxisLimitMode;
        const lock = (a: any): void => hknp.HP_Constraint_SetAxisMode(joint, a, mode.LOCKED);
        const limit = (a: any, min: number, max: number): void => {
            hknp.HP_Constraint_SetAxisMode(joint, a, mode.LIMITED);
            hknp.HP_Constraint_SetAxisMinLimit(joint, a, min);
            hknp.HP_Constraint_SetAxisMaxLimit(joint, a, max);
        };
    `, "constraint axis configuration helpers");
    const select = statements[4];
    if (statements.length !== 5 || !select || !ts.isSwitchStatement(select)) context.contractError(configure, "Expected constraint configuration to end in its type switch.");
    context.assertExpressionShape(select.expression, "type", "constraint type selection");
    const hinge = select.caseBlock.clauses.find(clause => ts.isCaseClause(clause) && ts.isPropertyAccessExpression(clause.expression) && clause.expression.name.text === "HINGE");
    if (!hinge || !ts.isCaseClause(hinge)) context.contractError(select, "Expected the HINGE constraint configuration.");
    context.assertExpressionShape(hinge.expression, "PhysicsConstraintType.HINGE", "hinge constraint selection");
    context.assertStatementShapes(hinge, hinge.statements, `
        lock(axis.LINEAR_X); lock(axis.LINEAR_Y); lock(axis.LINEAR_Z);
        lock(axis.ANGULAR_Y); lock(axis.ANGULAR_Z); break;
    `, "hinge locked and free axes");
    const enumMembers = (name: string) => context.objectInitializer(factory.file, name).properties.map(property => {
        if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) context.contractError(property, "Constraint enumerators must be named numeric properties.");
        return [property.name.text, context.numericValue(property.initializer, factory.file)] as const;
    });
    const typeMembers = enumMembers("PhysicsConstraintType");
    const axisMembers = enumMembers("PhysicsConstraintAxis");
    const axisNames = ["LINEAR_X", "LINEAR_Y", "LINEAR_Z", "ANGULAR_X", "ANGULAR_Y", "ANGULAR_Z", "LINEAR_DISTANCE"];
    const scalar = (cpp: string): PinnedBinding => ({ cpp, type: "scalar" });
    const bindings = () => new Map<string, PinnedBinding>([
        ...typeMembers.map(([name, value]) => [`PhysicsConstraintType.${name}`, { ...scalar(`${value}.0`), staticNumber: value }] as const),
        ...axisMembers.map(([name, value]) => [`PhysicsConstraintAxis.${name}`, { ...scalar(`${value}.0`), staticNumber: value }] as const),
        ...axisNames.map((name, index) => [`axis.${name}`, scalar(`${index}.0`)] as const),
    ]);
    const axisMapping = context.functionDeclaration(module, "constraintAxisToNative");
    const axisLowerer = new PinnedNumericLowerer(axisMapping.file, {
        calls: new Map(),
        bindings: new Map([...bindings(), ["value", scalar("value")]]),
        returnValue: value => value ? axisLowerer.expression(value) : context.contractError(axisMapping.declaration, "A constraint axis mapping must return a value."),
    });
    const nativeAxis = `double native_constraint_axis(double value) {\n${axisLowerer.statements(axisMapping.declaration.body!.statements, "    ").join("\n")}\n    throw std::runtime_error("Unknown constraint axis.");\n}`;
    const configurations = select.caseBlock.clauses.map(clause => {
        if (!ts.isCaseClause(clause) || !ts.isPropertyAccessExpression(clause.expression)) context.contractError(clause, "Constraint configuration requires named type cases.");
        const name = clause.expression.name.text;
        const value = typeMembers.find(([member]) => member === name)?.[1];
        if (value === undefined) context.contractError(clause, "Unknown constraint type configuration.");
        context.assertExpressionShape(clause.expression, `PhysicsConstraintType.${name}`, "constraint type selection");
        const scopeBindings = bindings();
        scopeBindings.set("options.maxDistance", { ...scalar("*options.max_distance"), absentCpp: "!options.max_distance" });
        scopeBindings.set("l.minLimit", { ...scalar("l.minimum"), absentCpp: "false" });
        scopeBindings.set("l.maxLimit", { ...scalar("l.maximum"), absentCpp: "false" });
        for (const field of ["minLimit", "maxLimit"])
            scopeBindings.set(`l.${field} !== undefined`, { cpp: "true", type: "bool", staticBoolean: true });
        scopeBindings.set("l.stiffness", { ...scalar("0.0"), staticallyAbsent: true });
        scopeBindings.set("l.damping", { ...scalar("0.0"), staticallyAbsent: true });
        scopeBindings.set("l.axis", scalar("l.axis"));
        const element = (axis: string) => `axes.at(static_cast<std::size_t>(${axis}))`;
        const lowerer = new PinnedNumericLowerer(factory.file, {
            bindings: scopeBindings,
            booleanAnd: true, booleanOr: true,
            expression: (node, lowerer) => {
                if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && context.expressionMatchesShape(node.left, "options.maxDistance"))
                    return `(options.max_distance ? *options.max_distance : ${lowerer.expression(node.right)})`;
                for (const field of ["minLimit", "maxLimit", "stiffness", "damping"]) {
                    if (context.expressionMatchesShape(node, `l.${field} !== undefined`))
                        return field === "minLimit" || field === "maxLimit" ? "true" : "false";
                }
                return undefined;
            },
            statement: node => {
                if (!ts.isIfStatement(node)) return undefined;
                for (const [field, setter] of [["stiffness", "Stiffness"], ["damping", "Damping"]]) {
                    if (!context.expressionMatchesShape(node.expression, `l.${field} !== undefined`)) continue;
                    context.assertStatementShapes(node, [node], `if (l.${field} !== undefined) { hknp.HP_Constraint_SetAxis${setter}(joint, nativeAxis, l.${field}); }`, "Absent constraint spring option");
                    return [];
                }
                return undefined;
            },
            calls: new Map([
                ["lock", args => `${element(args[0]!)}.mode = pal::PhysicsConstraintAxisMode::locked`],
                ["limit", args => `${element(args[0]!)} = {pal::PhysicsConstraintAxisMode::limited, ${args[1]}, ${args[2]}}`],
                ["constraintAxisToNative", args => `native_constraint_axis(${args[1]})`],
                ["hknp.HP_Constraint_SetAxisMode", args => `${element(args[1]!)}.mode = ${args[2]}`],
                ["hknp.HP_Constraint_SetAxisMinLimit", args => `${element(args[1]!)}.minimum = ${args[2]}`],
                ["hknp.HP_Constraint_SetAxisMaxLimit", args => `${element(args[1]!)}.maximum = ${args[2]}`],
            ]),
            forOf: (range, name) => range === "limits" && name === "l" ? { range: "limits", bindings: new Map([[name, { cpp: name, type: "opaque" }]]) } : undefined,
        });
        scopeBindings.set("axis", { cpp: "0", type: "opaque" });
        scopeBindings.set("joint", { cpp: "0", type: "opaque" });
        scopeBindings.set("mode.LIMITED", { cpp: "pal::PhysicsConstraintAxisMode::limited", type: "opaque" });
        const body = clause.statements.length === 1 && ts.isBlock(clause.statements[0]!) ? clause.statements[0]!.statements : clause.statements;
        const last = body[body.length - 1];
        if (!last || !ts.isBreakStatement(last)) context.contractError(clause, "Constraint type configuration must terminate with break.");
        return `    if (type == ${value}.0) {\n${lowerer.statements(body.slice(0, -1), "        ").join("\n")}\n        return axes;\n    }`;
    }).join("\n");
    const normalFunctions = ["normalizeVec3", "normalTo"].map(name => {
        const { file, declaration } = context.functionDeclaration(module, name);
        const parameter = name === "normalTo" ? "axis" : "v";
        const lowerer: PinnedNumericLowerer = new PinnedNumericLowerer(file, {
            bindings: new Map([[parameter, { cpp: parameter, type: "vec3" as const }]]),
            calls: new Map([...pinnedNumericMathCallsWithHypot(), ["normalizeVec3", args => `constraint_normalize(${args.join(", ")})`]]),
            booleanAnd: true,
            vec3Literal: (x, y, z) => `Vec3d{${x}, ${y}, ${z}}`,
            returnValue: expression => {
                if (!expression) context.contractError(declaration, "A constraint normal helper must return a vector.");
                return lowerer.expression(expression);
            },
        });
        return `Vec3d ${name === "normalTo" ? "constraint_normal_to" : "constraint_normalize"}(Vec3d ${parameter}) {\n${lowerer.statements(declaration.body!.statements, "    ").join("\n")}\n}`;
    }).join("\n");
    const header = `
struct PhysicsConstraintOptions {
    js::Nullable<Vec3d> pivot_a{}, pivot_b{}, axis_a{}, axis_b{}, perp_axis_a{}, perp_axis_b{};
    js::Nullable<double> max_distance{};
    bool collision = false;
};
struct PhysicsConstraintLimit { double axis, minimum, maximum; };
pal::PhysicsConstraintAxes physics_constraint_axes(double type, const PhysicsConstraintOptions& options, const std::vector<PhysicsConstraintLimit>& limits);
void create_physics_constraint(PhysicsWorldHandle world, PhysicsBody body_a, PhysicsBody body_b, double type, const PhysicsConstraintOptions& options = {}, const std::vector<PhysicsConstraintLimit>& limits = {});
`;
    const source = `
namespace {
${normalFunctions}
${nativeAxis}
}
pal::PhysicsConstraintAxes physics_constraint_axes(double type, const PhysicsConstraintOptions& options, const std::vector<PhysicsConstraintLimit>& limits) {
    pal::PhysicsConstraintAxes axes{};
${configurations}
    throw std::runtime_error("Unknown constraint type.");
}
// ${context.provenance(module, "createPhysicsConstraint", "anchor defaults and source-selected axes; PAL joint solver")}
void create_physics_constraint(PhysicsWorldHandle world, PhysicsBody body_a, PhysicsBody body_b, double type, const PhysicsConstraintOptions& options, const std::vector<PhysicsConstraintLimit>& limits) {
    const Vec3d pivot_a = options.pivot_a ? *options.pivot_a : Vec3d{0, 0, 0};
    const Vec3d pivot_b = options.pivot_b ? *options.pivot_b : Vec3d{0, 0, 0};
    const Vec3d axis_a = options.axis_a ? *options.axis_a : Vec3d{1, 0, 0};
    const Vec3d axis_b = options.axis_b ? *options.axis_b : Vec3d{1, 0, 0};
    const Vec3d perpendicular_a = options.perp_axis_a ? *options.perp_axis_a : constraint_normal_to(axis_a);
    const Vec3d perpendicular_b = options.perp_axis_b ? *options.perp_axis_b : constraint_normal_to(axis_b);
    const pal::PhysicsConstraintAnchor parent{{pivot_a.x, pivot_a.y, pivot_a.z}, {axis_a.x, axis_a.y, axis_a.z}, {perpendicular_a.x, perpendicular_a.y, perpendicular_a.z}};
    const pal::PhysicsConstraintAnchor child{{pivot_b.x, pivot_b.y, pivot_b.z}, {axis_b.x, axis_b.y, axis_b.z}, {perpendicular_b.x, perpendicular_b.y, perpendicular_b.z}};
    if (type == ${typeMembers.find(([name]) => name === "HINGE")![1]}.0) {
        pal::physics_world_create_hinge(physics_world_record(world).handle, body_a.handle, body_b.handle, parent, child, options.collision);
    } else {
        pal::physics_world_create_constraint(physics_world_record(world).handle, body_a.handle, body_b.handle, parent, child, physics_constraint_axes(type, options, limits), options.collision);
    }
}
`;
    return { header, source };
}
