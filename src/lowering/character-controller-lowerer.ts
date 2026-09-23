import ts from "typescript";
import { forEachAnalysisNode } from "../compiler/analysis-walk.js";
import {
    isAssignmentExpression,
    isUpdateExpression,
} from "../compiler/syntax.js";
import type { LoweringContext } from "./context.js";
import {
    PinnedReferenceLowerer,
    type ReferenceFunction,
    type ReferenceSchema,
    type ReferenceValue,
} from "./pinned-reference-lowerer.js";
import {
    characterTransportSchema,
    lowerCharacterCollectorCasts,
    massPropertiesType,
    queryResultType,
} from "./character-controller-transport.js";
import { lowerMat4InvertCpp } from "./pinned-function-lowerer.js";

export const characterControllerModule = "src/physics/character-controller.ts";

const kernelMethods = [
    "calculateMovement",
    "_compareContacts",
    "_findContact",
    "_addMaxSlopePlane",
    "_resolveConstraintPenetration",
    "_createConstraintsFromManifold",
    "_getOutput",
    "_sortInfo",
    "_solve1d",
    "_solveTest1d",
    "_solve2d",
    "_solve3d",
    "_examineActivePlanes",
    "_copyPlane",
    "_simplexSolverSolve",
] as const;

/** The module's own vector helpers the kernel calls, `v` and `v<op>`. */
const vectorHelpers: ReadonlySet<string> = new Set(
    [
        "",
        "clone",
        "copy",
        "set",
        "add",
        "sub",
        "scale",
        "addIn",
        "subIn",
        "scaleIn",
        "dot",
        "cross",
        "lenSq",
        "len",
        "normIn",
        "equalsEps",
    ].map((operation) => `v${operation}`),
);

/** The controller's reference-bearing solver arithmetic is emitted from the pin's AST.
 * Body kinematics and contact construction are separate transport-dependent methods. */
export function lowerCharacterControllerKernel(
    context: LoweringContext,
    full = false,
): string {
    const { file, declaration: controller } = context.classDeclaration(
        characterControllerModule,
        "PhysicsCharacterController",
    );
    const records = new Map<string, Map<string, string>>();
    const vector = context.functionDeclaration(
        characterControllerModule,
        "v",
    ).declaration;
    const returned = vector.body!.statements[0];
    if (
        !returned ||
        !ts.isReturnStatement(returned) ||
        !returned.expression ||
        !ts.isObjectLiteralExpression(returned.expression)
    )
        return context.contractError(
            vector,
            "Pinned vector helper must return its component record.",
        );
    records.set(
        "Vec3",
        new Map(
            returned.expression.properties.map((property) => {
                if (!ts.isShorthandPropertyAssignment(property))
                    return context.contractError(
                        property,
                        "Pinned vector components must be named helper parameters.",
                    );
                return [property.name.text, "number"];
            }),
        ),
    );
    records.set("PhysicsBody", new Map());
    records.set("NativeBody", new Map());
    if (full) {
        records.set(
            "QueryPoint",
            new Map([
                ["identity", "number[]"],
                ["position", "number[]"],
                ["normal", "number[]"],
            ]),
        );
        records.set(
            "Quat",
            new Map(["x", "y", "z", "w"].map((name) => [name, "number"])),
        );
        for (const name of [
            "PhysicsWorld",
            "PhysicsShape",
            "TransformNode",
            "QueryCollector",
        ])
            records.set(name, new Map());
        records.set(
            "CapsuleParameters",
            new Map([
                ["pointA", "Vec3"],
                ["pointB", "Vec3"],
                ["radius", "number"],
            ]),
        );
        records.set(
            "ShapeDescription",
            new Map([
                ["type", "number"],
                ["parameters", "CapsuleParameters"],
            ]),
        );
        records.set("InertiaOverride", new Map([["inertia", "Vec3"]]));
    }
    const interfaces = file.statements.filter(
        (node): node is ts.InterfaceDeclaration =>
            ts.isInterfaceDeclaration(node),
    );
    for (const record of interfaces) records.set(record.name.text, new Map());
    const functions = new Map<string, ReferenceFunction>();
    const bindings = new Map<string, ReferenceValue>();
    const schema: ReferenceSchema = {
        records,
        functions,
        bindings,
        returnType: "void",
        numberAliases: new Set([
            "InteractionStatus",
            "CharacterSupportedState",
        ]),
        ...(full
            ? {
                  typeAliases: new Map([
                      ["Mat4", "number[]"],
                      ["unknown", "optional:number"],
                  ]),
                  ownedAssignments: new Set(["this._body"]),
                  ...characterTransportSchema(context),
              }
            : {}),
    };
    const lowerer = new PinnedReferenceLowerer(context, schema);
    for (const record of interfaces) {
        const fields = records.get(record.name.text)!;
        for (const member of record.members) {
            if (
                !ts.isPropertySignature(member) ||
                !ts.isIdentifier(member.name) ||
                !member.type
            )
                return context.contractError(
                    member,
                    "Pinned controller record must have typed data fields.",
                );
            if (
                record.name.text === "Contact" &&
                member.name.text === "nativeBody"
            ) {
                if (member.type.getText(file) !== "any | null")
                    return context.contractError(
                        member,
                        "Contact native handle type changed.",
                    );
                fields.set(member.name.text, "NativeBody");
            } else fields.set(member.name.text, lowerer.type(member.type));
        }
    }
    if (full)
        for (const [name, type] of records.get(
            "PhysicsCharacterControllerOptions",
        )!)
            records
                .get("PhysicsCharacterControllerOptions")!
                .set(name, `optional:${type}`);
    const { declaration: status } = context.enumDeclaration(
        characterControllerModule,
        "InteractionStatus",
    );
    for (const member of status.members) {
        if (!ts.isIdentifier(member.name) || !member.initializer)
            return context.contractError(
                member,
                "Pinned interaction status must have an explicit numeric value.",
            );
        bindings.set(
            `InteractionStatus.${member.name.text}`,
            lowerer.expression(member.initializer),
        );
    }
    if (full) {
        for (const [module, name] of [
            [characterControllerModule, "CharacterSupportedState"],
            ["src/physics/havok.ts", "PhysicsMotionType"],
            ["src/physics/havok.ts", "PhysicsShapeType"],
        ]) {
            const constant = context.pinnedConstant(module!, name!);
            const value =
                constant && context.unwrapExpression(constant.initializer);
            if (!value || !ts.isObjectLiteralExpression(value))
                return context.contractError(
                    value ?? context.sourceFile(module!),
                    "Pinned controller state constants must be an object.",
                );
            for (const property of value.properties) {
                if (
                    !ts.isPropertyAssignment(property) ||
                    !ts.isIdentifier(property.name)
                )
                    return context.contractError(
                        property,
                        "Pinned controller state requires numeric named constants.",
                    );
                bindings.set(
                    `${name}.${property.name.text}`,
                    lowerer.expression(property.initializer),
                );
            }
        }
        bindings.set("this._world._bodies", {
            cpp: "_world_bodies()",
            type: "PhysicsBody[]",
        });
    }
    const helpers = file.statements.filter(
        (node): node is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(node) &&
            !!node.name &&
            (node.name.text === "clamp" ||
                (full &&
                    ["transformCoord", "matToArray"].includes(
                        node.name.text,
                    )) ||
                vectorHelpers.has(node.name.text)),
    );
    const methodNames = full
        ? [
              ...kernelMethods,
              "getPosition",
              "getBody",
              "setPosition",
              "getVelocity",
              "setVelocity",
              "moveWithCollisions",
              "integrate",
              "checkSupport",
              "_integrateManifolds",
              "_castWithCollectors",
              "_findBody",
              "_contactFromCast",
              "_validateManifold",
              "_updateManifold",
              "_getMassProperties",
              "_getComWorld",
              "_getBodyWorldMatrix",
              "_getPointVelocity",
              "_getInvMass",
              "_createSurfaceConstraint",
              "_resolveContacts",
              "setShapeOptions",
              "dispose",
          ]
        : kernelMethods;
    const methods = methodNames.map((name) => {
        const method = controller.members.find(
            (member): member is ts.MethodDeclaration =>
                ts.isMethodDeclaration(member) &&
                ts.isIdentifier(member.name) &&
                member.name.text === name,
        );
        if (!method)
            return context.contractError(
                controller,
                `Pinned controller method ${name} is missing.`,
            );
        return method;
    });
    const signature = (
        name: string,
        declaration: ts.FunctionDeclaration | ts.MethodDeclaration,
    ): ReferenceFunction => {
        if (!declaration.type)
            return context.contractError(
                declaration,
                "Pinned controller function requires a return type.",
            );
        const parameters = declaration.parameters.map((parameter) => {
            if (parameter.name.getText(file) === "nativeBody") {
                if (parameter.initializer)
                    context.assertExpressionShape(
                        parameter.initializer,
                        "body._hkBody",
                        "Default native body identity",
                    );
                else if (parameter.type?.kind !== ts.SyntaxKind.AnyKeyword)
                    return context.contractError(
                        parameter,
                        "Native body handle annotation changed.",
                    );
                return "NativeBody";
            }
            return parameter.type?.kind === ts.SyntaxKind.AnyKeyword &&
                name === "_contactFromCast"
                ? "QueryPoint"
                : parameter.type
                  ? lowerer.type(parameter.type)
                  : parameter.initializer
                    ? lowerer.expression(parameter.initializer).type
                    : context.contractError(
                          parameter,
                          "Pinned controller parameter requires a represented type.",
                      );
        });
        return {
            cpp: name,
            parameters,
            requiredParameters: declaration.parameters.filter(
                (parameter) =>
                    !parameter.initializer && !parameter.questionToken,
            ).length,
            returns:
                declaration.type.kind === ts.SyntaxKind.AnyKeyword &&
                name === "_getMassProperties"
                    ? massPropertiesType
                    : lowerer.type(declaration.type),
        };
    };
    for (const helper of helpers)
        functions.set(helper.name!.text, signature(helper.name!.text, helper));
    for (const method of methods)
        functions.set(
            `this.${method.name.getText(file)}`,
            signature(method.name.getText(file), method),
        );
    if (!full)
        for (const name of ["_getPointVelocity", "_createSurfaceConstraint"]) {
            const declaration = controller.members.find(
                (member): member is ts.MethodDeclaration =>
                    ts.isMethodDeclaration(member) &&
                    member.name.getText(file) === name,
            )!;
            functions.set(`this.${name}`, signature(name, declaration));
        }
    if (full) {
        functions.set("this._node.position.set", {
            cpp: "_set_node_position",
            parameters: ["number", "number", "number"],
            requiredParameters: 3,
            returns: "void",
        });
        functions.set("this.onTriggerCollisionObservable.notify", {
            cpp: "_notify",
            parameters: ["CharacterCollisionEvent"],
            requiredParameters: 1,
            returns: "void",
        });
        functions.set("invertMat4", {
            cpp: "_matrix_inverse",
            parameters: ["number[]"],
            requiredParameters: 1,
            returns: "optional:number[]",
        });
        const zero = context.variableInitializer(file, "ZERO");
        bindings.set("ZERO", lowerer.expression(zero, "Vec3"));
        const borrowedAdapterParameters = new Map<string, readonly number[]>([
            ["createPhysicsShape", [0]],
            ["createPhysicsBody", [0]],
            ["setPhysicsBodyShape", [0, 1]],
            ["setPhysicsBodyMassProperties", [0, 1]],
            ["setPhysicsBodyPreStep", [0]],
            ["removePhysicsBody", [0, 1]],
        ]);
        for (const [name, cpp, parameters, returns] of [
            [
                "createPhysicsShape",
                "_create_shape",
                ["PhysicsWorld", "ShapeDescription"],
                "PhysicsShape",
            ],
            [
                "createTransformNode",
                "_create_node",
                ["string", "number", "number", "number"],
                "TransformNode",
            ],
            [
                "createPhysicsBody",
                "_create_body",
                ["PhysicsWorld", "TransformNode", "number"],
                "PhysicsBody",
            ],
            [
                "setPhysicsBodyShape",
                "_set_body_shape",
                ["PhysicsWorld", "PhysicsBody", "PhysicsShape"],
                "void",
            ],
            [
                "setPhysicsBodyMassProperties",
                "_set_body_mass_properties",
                ["PhysicsWorld", "PhysicsBody", "InertiaOverride"],
                "void",
            ],
            [
                "setPhysicsBodyPreStep",
                "_set_body_pre_step",
                ["PhysicsBody", "boolean"],
                "void",
            ],
            [
                "removePhysicsBody",
                "_remove_body",
                ["PhysicsWorld", "PhysicsBody"],
                "void",
            ],
        ] as const)
            functions.set(name, {
                cpp,
                parameters,
                requiredParameters: parameters.length,
                returns,
                ...(borrowedAdapterParameters.has(name)
                    ? {
                          borrowedParameters: new Set(
                              borrowedAdapterParameters.get(name),
                          ),
                      }
                    : {}),
            });
    }
    const fields = controller.members.filter(
        (member): member is ts.PropertyDeclaration =>
            ts.isPropertyDeclaration(member) &&
            ts.isIdentifier(member.name) &&
            ((!member.name.text.startsWith("_") &&
                member.name.text !== "onTriggerCollisionObservable") ||
                [
                    "_position",
                    "_velocity",
                    "_lastVelocity",
                    "_lastDisplacement",
                    "_manifold",
                    "_lastInvDeltaTime",
                    "_frameId",
                    "_contactAngleSensitivity",
                    "_displacementEps",
                    ...(full
                        ? [
                              "_world",
                              "_shape",
                              "_shapeOptions",
                              "_node",
                              "_body",
                              "_orientation",
                              "_bodyTracking",
                              "_startCollector",
                              "_castCollector",
                          ]
                        : []),
                ].includes(member.name.text)),
    );
    for (const field of fields) {
        const type = ["_startCollector", "_castCollector"].includes(
            field.name.getText(file),
        )
            ? "QueryCollector"
            : field.type
              ? lowerer.type(field.type)
              : field.initializer
                ? lowerer.expression(field.initializer).type
                : context.contractError(
                      field,
                      "Pinned controller field requires a represented type.",
                  );
        bindings.set(`this.${field.name.getText(file)}`, {
            cpp: field.name.getText(file),
            type,
            borrowed: "mutable",
        });
    }
    const hasDependentDefault = (
        declaration: ts.FunctionDeclaration | ts.MethodDeclaration,
    ): boolean => {
        const preceding = new Set<string>();
        return declaration.parameters.some((parameter) => {
            const visit = (node: ts.Node): boolean =>
                (ts.isIdentifier(node) && preceding.has(node.text)) ||
                ts.forEachChild(node, visit) === true;
            const dependent = parameter.initializer
                ? visit(parameter.initializer)
                : false;
            preceding.add(parameter.name.getText(file));
            return dependent;
        });
    };
    const reboundParameterNames = (
        declaration:
            | ts.FunctionDeclaration
            | ts.MethodDeclaration
            | ts.ConstructorDeclaration,
    ): ReadonlySet<string> => {
        const rebound = new Set<string>();
        if (declaration.body)
            forEachAnalysisNode(
                declaration.body,
                (node) => {
                    const target = isAssignmentExpression(node)
                        ? node.left
                        : isUpdateExpression(node)
                          ? node.operand
                          : undefined;
                    if (target && ts.isIdentifier(target))
                        rebound.add(target.text);
                },
                { functions: "skip", types: "skip" },
            );
        return rebound;
    };
    const prototype = (
        name: string,
        declaration: ts.FunctionDeclaration | ts.MethodDeclaration,
        defaults: boolean,
        count = declaration.parameters.length,
    ): string => {
        const fn = functions.get(
            ts.isMethodDeclaration(declaration) ? `this.${name}` : name,
        )!;
        const nativeDefaults = defaults && !hasDependentDefault(declaration);
        const parameters = declaration.parameters
            .slice(0, count)
            .map((parameter, index) => {
                if (
                    !ts.isIdentifier(parameter.name) ||
                    parameter.dotDotDotToken
                )
                    return context.contractError(
                        parameter,
                        "Pinned controller parameter must be ordinary and named.",
                    );
                const initializer = parameter.initializer;
                const storage = lowerer.storage(fn.parameters[index]!);
                const parameterType = fn.borrowedParameters?.has(index)
                    ? `const ${storage}&`
                    : storage;
                return `[[maybe_unused]] ${parameterType} ${parameter.name.text}${nativeDefaults && initializer ? ` = ${lowerer.expression(initializer, fn.parameters[index]).cpp}` : nativeDefaults && parameter.questionToken ? " = {}" : ""}`;
            });
        return `${lowerer.storage(fn.returns)} ${name}(${parameters.join(", ")})`;
    };
    const definition = (
        declaration: ts.FunctionDeclaration | ts.MethodDeclaration,
    ): string => {
        const name = declaration.name!.getText(file);
        const fn = functions.get(
            ts.isMethodDeclaration(declaration) ? `this.${name}` : name,
        )!;
        const locals = new Map(bindings);
        const rebound = reboundParameterNames(declaration);
        for (const [index, parameter] of declaration.parameters.entries())
            locals.set(parameter.name.getText(file), {
                cpp: parameter.name.getText(file),
                type: fn.parameters[index]!,
                borrowed:
                    declaration.body &&
                    ts.isIdentifier(parameter.name) &&
                    !rebound.has(parameter.name.text)
                        ? "stable"
                        : "mutable",
            });
        const body = new PinnedReferenceLowerer(context, {
            ...schema,
            bindings: locals,
            returnType: fn.returns,
        });
        const source =
            full && name === "_castWithCollectors"
                ? lowerCharacterCollectorCasts(
                      context,
                      declaration as ts.MethodDeclaration,
                      body,
                  )
                : body.statements(declaration.body!.statements);
        const overloads: string[] = [];
        if (hasDependentDefault(declaration))
            for (
                let count = fn.requiredParameters;
                count < declaration.parameters.length;
                count++
            ) {
                const initializers = declaration.parameters
                    .slice(count)
                    .map((parameter, offset) => {
                        const type = fn.parameters[count + offset]!;
                        const value = parameter.initializer
                            ? body.expression(parameter.initializer, type).cpp
                            : "{}";
                        return `    ${lowerer.storage(type)} ${parameter.name.getText(file)} = ${value};`;
                    });
                overloads.push(
                    `${prototype(name, declaration, false, count)} {\n${initializers.join("\n")}\n    return ${name}(${declaration.parameters.map((parameter) => parameter.name.getText(file)).join(", ")});\n}`,
                );
            }
        return `// ${context.provenance(characterControllerModule, ts.isMethodDeclaration(declaration) ? `PhysicsCharacterController.${name}` : name)}\n${prototype(name, declaration, ts.isMethodDeclaration(declaration))} {\n${source}\n}\n${overloads.join("\n")}`;
    };
    const recordTypes = [
        "Vec3",
        ...(full
            ? [
                  "QueryPoint",
                  "Quat",
                  "CapsuleParameters",
                  "ShapeDescription",
                  "InertiaOverride",
              ]
            : []),
        ...interfaces.map((record) => record.name.text),
    ];
    let initialize = "";
    if (full) {
        const constructor = controller.members.find(
            ts.isConstructorDeclaration,
        )!;
        const bodyAssignments = context.findNodes(
            controller,
            (node): node is ts.BinaryExpression =>
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                node.left.getText(file) === "this._body",
        );
        if (
            bodyAssignments.length !== 1 ||
            !ts.findAncestor(bodyAssignments[0], (node) => node === constructor)
        )
            return context.contractError(
                controller,
                "Pinned controller body ownership assignment changed.",
            );
        const locals = new Map(bindings);
        const rebound = reboundParameterNames(constructor);
        for (const parameter of constructor.parameters)
            locals.set(parameter.name.getText(file), {
                cpp: parameter.name.getText(file),
                type: lowerer.type(parameter.type!),
                borrowed:
                    constructor.body &&
                    ts.isIdentifier(parameter.name) &&
                    !rebound.has(parameter.name.text)
                        ? "stable"
                        : "mutable",
            });
        initialize = `void initialize(const js::Ref<PhysicsWorld>& world, js::Ref<Vec3> position, js::Ref<PhysicsCharacterControllerOptions> options) {\n${new PinnedReferenceLowerer(context, { ...schema, bindings: locals }).statements(constructor.body!.statements)}\n}`;
    }
    return `#pragma once
#include <bblite/js_data.hpp>
#include <tuple>
namespace bbl::character {
struct PhysicsBody;
struct NativeBody;
${full ? "struct PhysicsWorld; struct PhysicsShape; struct TransformNode; struct QueryCollector;" : ""}
${recordTypes.map((name) => `struct ${name};`).join("\n")}
${recordTypes.map((name) => `struct ${name} {\n${[...records.get(name)!].map(([field, type]) => `    ${lowerer.storage(type)} ${field}{};`).join("\n")}\n};`).join("\n")}
${helpers.map((declaration) => `inline ${prototype(declaration.name!.text, declaration, true)};`).join("\n")}
${helpers.map((declaration) => `inline ${definition(declaration)}`).join("\n")}
${
    full
        ? `${lowerMat4InvertCpp(context, { inline: true, cppName: "_inverse_storage" })}
inline std::optional<js::Array<double>> _matrix_inverse(const js::Array<double>& input) {
    std::array<float, 16> values{};
    for (std::size_t i = 0; i < values.size(); ++i) values[i] = static_cast<float>(input.at(i));
    const auto inverse = _inverse_storage(values);
    if (!inverse) return std::nullopt;
    return js::Array<double>(inverse->begin(), inverse->end());
}`
        : ""
}
struct CharacterControllerKernel {
    virtual ~CharacterControllerKernel() = default;
${
    full
        ? `    virtual js::Array<js::Ref<PhysicsBody>> _world_bodies() = 0;
    virtual js::Ref<PhysicsShape> _create_shape(const js::Ref<PhysicsWorld>&, js::Ref<ShapeDescription>) = 0;
    virtual js::Ref<TransformNode> _create_node(std::string, double, double, double) = 0;
    virtual js::Ref<PhysicsBody> _create_body(const js::Ref<PhysicsWorld>&, js::Ref<TransformNode>, double) = 0;
    virtual void _set_body_shape(const js::Ref<PhysicsWorld>&, const js::Ref<PhysicsBody>&, js::Ref<PhysicsShape>) = 0;
    virtual void _set_body_mass_properties(const js::Ref<PhysicsWorld>&, const js::Ref<PhysicsBody>&, js::Ref<InertiaOverride>) = 0;
    virtual void _set_body_pre_step(const js::Ref<PhysicsBody>&, bool) = 0;
    virtual void _remove_body(const js::Ref<PhysicsWorld>&, const js::Ref<PhysicsBody>&) = 0;
    virtual void _release_shape(js::Ref<PhysicsShape>) = 0;
    virtual js::Ref<QueryCollector> _create_collector(double) = 0;
    virtual void _release_collector(js::Ref<QueryCollector>) = 0;
    virtual double _world_step_seconds() = 0;
    virtual double _body_motion_type(js::Ref<PhysicsBody>) = 0;
    virtual std::optional<double> _body_identity(js::Ref<PhysicsBody>) = 0;
    virtual js::Ref<NativeBody> _native_body(js::Ref<PhysicsBody>) = 0;
    virtual std::optional<std::tuple<js::Ref<PhysicsBody>, js::Ref<NativeBody>, double>> _thin_resolve(std::optional<double>) = 0;
    virtual js::Ref<Vec3> _thin_com(js::Ref<PhysicsBody>, js::Ref<NativeBody>, js::Array<double>) = 0;
    virtual std::optional<js::Array<double>> _thin_matrix(js::Ref<PhysicsBody>, js::Ref<NativeBody>) = 0;
    virtual js::Array<double> _body_world_matrix(js::Ref<PhysicsBody>) = 0;
    virtual ${lowerer.storage(massPropertiesType)} _mass_properties(js::Ref<NativeBody>) = 0;
    virtual js::Array<double> _angular_velocity(js::Ref<NativeBody>) = 0;
    virtual js::Array<double> _linear_velocity(js::Ref<NativeBody>) = 0;
    virtual void _apply_impulse(js::Ref<NativeBody>, js::Array<double>, js::Array<double>) = 0;
    virtual void _set_node_position(double, double, double) = 0;
    virtual void _notify(js::Ref<CharacterCollisionEvent>) = 0;
    virtual js::Array<${lowerer.storage(queryResultType)}> _start_hits() = 0;
    virtual js::Array<${lowerer.storage(queryResultType)}> _cast_hits() = 0;
    virtual void _collect_proximity(js::Array<double>, js::Array<double>, double, bool) = 0;
    virtual void _collect_cast(js::Array<double>, js::Array<double>, js::Array<double>, bool) = 0;`
        : `    virtual js::Ref<Vec3> _getPointVelocity(js::Ref<PhysicsBody>, js::Ref<Vec3>, js::Ref<NativeBody>) = 0;
    virtual js::Ref<SurfaceConstraint> _createSurfaceConstraint(double, js::Ref<Contact>, double) = 0;`
}
${fields
    .map((field) => {
        const binding = bindings.get(`this.${field.name.getText(file)}`)!;
        return `    ${lowerer.storage(binding.type)} ${binding.cpp}${field.initializer ? ` = ${lowerer.expression(field.initializer, binding.type).cpp}` : "{}"};`;
    })
    .join("\n")}
${methods.map(definition).join("\n")}
${initialize}
};
} // namespace bbl::character
`;
}
