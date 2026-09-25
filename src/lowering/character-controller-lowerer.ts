import {
    type RecordShape,
    recordScalars,
    recordOf,
    arrayOf,
    optionalOf,
} from "./record-shapes.js";
import ts from "typescript";
import { resolvedSymbol } from "../compiler/symbols.js";
import { forEachAnalysisNode } from "../compiler/analysis-walk.js";
import {
    isAssignmentExpression,
    isUpdateExpression,
} from "../compiler/syntax.js";
import type { LoweringContext } from "./context.js";
import {
    CharacterKernelLowerer,
    type KernelFunction,
    type KernelSchema,
    type KernelValue,
} from "./character-kernel-lowerer.js";
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

type KernelDeclaration = ts.FunctionDeclaration | ts.MethodDeclaration;

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
    const checker = context.program.checkerFor(file);
    const records = new Map<string, Map<string, RecordShape>>();
    const functions = new Map<ts.Declaration, KernelFunction>();
    const values = new Map<ts.Declaration, KernelValue>();
    const declared = new Map<ts.Declaration, RecordShape>();
    const interfaces = file.statements.filter(
        (node): node is ts.InterfaceDeclaration =>
            ts.isInterfaceDeclaration(node),
    );
    const vector = context.functionDeclaration(
        characterControllerModule,
        "v",
    ).declaration;
    const quat = full
        ? controller.members.find(
              (member): member is ts.PropertyDeclaration =>
                  ts.isPropertyDeclaration(member) &&
                  member.name.getText(file) === "_orientation",
          )
        : undefined;
    // Every record is named before any field is typed, since a field's
    // type may be another record.
    for (const name of [
        "Vec3",
        "PhysicsBody",
        "NativeBody",
        ...(full
            ? [
                  "QueryPoint",
                  "Quat",
                  "PhysicsWorld",
                  "PhysicsShape",
                  "TransformNode",
                  "QueryCollector",
                  "CapsuleParameters",
                  "ShapeDescription",
                  "InertiaOverride",
              ]
            : []),
        ...interfaces.map((record) => record.name.text),
    ])
        records.set(name, new Map<string, RecordShape>());
    const schema: KernelSchema = {
        records,
        functions,
        values,
        declared,
        returnType: recordScalars.void,
        ...(full
            ? {
                  unknown: optionalOf(recordScalars.number),
                  ...characterTransportSchema(context),
              }
            : {}),
    };
    const lowerer = new CharacterKernelLowerer(context, file, schema);
    const typeFields = (type: ts.Type, at: ts.Node): Map<string, RecordShape> =>
        new Map(
            checker
                .getPropertiesOfType(type)
                .map((property) => [
                    property.getName(),
                    lowerer.representation(
                        checker.getTypeOfSymbolAtLocation(property, at),
                        at,
                    ),
                ]),
        );
    const vectorSignature = checker.getSignatureFromDeclaration(vector);
    if (!vectorSignature)
        return context.contractError(vector, "Pinned vector helper signature.");
    records.set(
        "Vec3",
        typeFields(checker.getReturnTypeOfSignature(vectorSignature), vector),
    );
    if (quat)
        records.set(
            "Quat",
            typeFields(checker.getTypeAtLocation(quat.name), quat),
        );
    if (full) {
        records.set(
            "QueryPoint",
            new Map<string, RecordShape>([
                ["identity", arrayOf(recordScalars.number)],
                ["position", arrayOf(recordScalars.number)],
                ["normal", arrayOf(recordScalars.number)],
            ]),
        );
        records.set(
            "CapsuleParameters",
            new Map<string, RecordShape>([
                ["pointA", recordOf("Vec3")],
                ["pointB", recordOf("Vec3")],
                ["radius", recordScalars.number],
            ]),
        );
        records.set(
            "ShapeDescription",
            new Map<string, RecordShape>([
                ["type", recordScalars.number],
                ["parameters", recordOf("CapsuleParameters")],
            ]),
        );
        records.set(
            "InertiaOverride",
            new Map<string, RecordShape>([["inertia", recordOf("Vec3")]]),
        );
    }
    for (const record of interfaces) {
        const fields = records.get(record.name.text)!;
        for (const member of record.members) {
            if (
                !ts.isPropertySignature(member) ||
                !ts.isIdentifier(member.name)
            )
                return context.contractError(
                    member,
                    "Pinned controller record must have typed data fields.",
                );
            if (
                record.name.text === "Contact" &&
                member.name.text === "nativeBody"
            ) {
                if (member.type?.getText(file) !== "any | null")
                    return context.contractError(
                        member,
                        "Contact native handle type changed.",
                    );
                declared.set(member, recordOf("NativeBody"));
            }
            const type = lowerer.declarationType(member);
            fields.set(
                member.name.text,
                full && record.name.text === "PhysicsCharacterControllerOptions"
                    ? optionalOf(type)
                    : type,
            );
        }
    }
    const helpers = file.statements.filter(
        (node): node is ts.FunctionDeclaration & { name: ts.Identifier } =>
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
    const method = (name: string): ts.MethodDeclaration =>
        controller.members.find(
            (member): member is ts.MethodDeclaration =>
                ts.isMethodDeclaration(member) &&
                ts.isIdentifier(member.name) &&
                member.name.text === name,
        ) ??
        context.contractError(
            controller,
            `Pinned controller method ${name} is missing.`,
        );
    const methods = methodNames.map(method);
    const methodName = (declaration: KernelDeclaration): string =>
        declaration.name!.getText(file);
    const signature = (declaration: KernelDeclaration): KernelFunction => {
        const name = methodName(declaration);
        if (!declaration.type)
            return context.contractError(
                declaration,
                "Pinned controller function requires a return type.",
            );
        for (const parameter of declaration.parameters) {
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
                declared.set(parameter, recordOf("NativeBody"));
            } else if (
                parameter.type?.kind === ts.SyntaxKind.AnyKeyword &&
                name === "_contactFromCast"
            )
                declared.set(parameter, recordOf("QueryPoint"));
        }
        if (
            declaration.type.kind === ts.SyntaxKind.AnyKeyword &&
            name === "_getMassProperties"
        )
            declared.set(declaration, massPropertiesType);
        const { parameters, returns } = lowerer.signature(declaration);
        return {
            cpp: name,
            parameters,
            requiredParameters: declaration.parameters.filter(
                (parameter) =>
                    !parameter.initializer && !parameter.questionToken,
            ).length,
            returns,
        };
    };
    for (const helper of helpers) functions.set(helper, signature(helper));
    for (const declaration of methods)
        functions.set(declaration, signature(declaration));
    if (!full)
        for (const name of ["_getPointVelocity", "_createSurfaceConstraint"]) {
            const declaration = method(name);
            functions.set(declaration, signature(declaration));
        }
    if (full) {
        const node = controller.members.find(
            (member): member is ts.PropertyDeclaration =>
                ts.isPropertyDeclaration(member) &&
                member.name.getText(file) === "_node",
        )!;
        // `TransformNode.position.set`, found through the node's own type.
        const position = checker.getPropertyOfType(
            checker.getTypeAtLocation(node.name),
            "position",
        );
        const set =
            position &&
            checker.getPropertyOfType(
                checker.getTypeOfSymbolAtLocation(position, node),
                "set",
            )?.valueDeclaration;
        if (!set)
            return context.contractError(
                node,
                "Pinned controller node position setter is missing.",
            );
        functions.set(set, {
            cpp: "_set_node_position",
            parameters: [
                recordScalars.number,
                recordScalars.number,
                recordScalars.number,
            ],
            requiredParameters: 3,
            returns: recordScalars.void,
        });
        const observable = context.classDeclaration(
            characterControllerModule,
            "CharacterCollisionObservable",
        ).declaration;
        const notify = observable.members.find(
            (member): member is ts.MethodDeclaration =>
                ts.isMethodDeclaration(member) &&
                member.name.getText(file) === "notify",
        );
        if (!notify)
            return context.contractError(
                observable,
                "Pinned collision observable notify is missing.",
            );
        functions.set(notify, {
            cpp: "_notify",
            parameters: [recordOf("CharacterCollisionEvent")],
            requiredParameters: 1,
            returns: recordScalars.void,
        });
        functions.set(
            context.functionDeclaration("src/math/invert-mat4.ts", "invertMat4")
                .declaration,
            {
                cpp: "_matrix_inverse",
                parameters: [arrayOf(recordScalars.number)],
                requiredParameters: 1,
                returns: optionalOf(arrayOf(recordScalars.number)),
            },
        );
        const borrowedAdapterParameters = new Map<string, readonly number[]>([
            ["createPhysicsShape", [0]],
            ["createPhysicsBody", [0]],
            ["setPhysicsBodyShape", [0, 1]],
            ["setPhysicsBodyMassProperties", [0, 1]],
            ["setPhysicsBodyPreStep", [0]],
            ["removePhysicsBody", [0, 1]],
        ]);
        for (const [module, name, cpp, parameters, returns] of [
            [
                "src/physics/havok.ts",
                "createPhysicsShape",
                "_create_shape",
                [recordOf("PhysicsWorld"), recordOf("ShapeDescription")],
                recordOf("PhysicsShape"),
            ],
            [
                "src/scene/transform-node.ts",
                "createTransformNode",
                "_create_node",
                [
                    recordScalars.string,
                    recordScalars.number,
                    recordScalars.number,
                    recordScalars.number,
                ],
                recordOf("TransformNode"),
            ],
            [
                "src/physics/havok.ts",
                "createPhysicsBody",
                "_create_body",
                [
                    recordOf("PhysicsWorld"),
                    recordOf("TransformNode"),
                    recordScalars.number,
                ],
                recordOf("PhysicsBody"),
            ],
            [
                "src/physics/havok.ts",
                "setPhysicsBodyShape",
                "_set_body_shape",
                [
                    recordOf("PhysicsWorld"),
                    recordOf("PhysicsBody"),
                    recordOf("PhysicsShape"),
                ],
                recordScalars.void,
            ],
            [
                "src/physics/havok.ts",
                "setPhysicsBodyMassProperties",
                "_set_body_mass_properties",
                [
                    recordOf("PhysicsWorld"),
                    recordOf("PhysicsBody"),
                    recordOf("InertiaOverride"),
                ],
                recordScalars.void,
            ],
            [
                "src/physics/havok.ts",
                "setPhysicsBodyPreStep",
                "_set_body_pre_step",
                [recordOf("PhysicsBody"), recordScalars.boolean],
                recordScalars.void,
            ],
            [
                "src/physics/havok.ts",
                "removePhysicsBody",
                "_remove_body",
                [recordOf("PhysicsWorld"), recordOf("PhysicsBody")],
                recordScalars.void,
            ],
        ] as const)
            functions.set(
                context.functionDeclaration(module, name).declaration,
                {
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
                },
            );
    }
    const fields = controller.members.filter(
        (member): member is ts.PropertyDeclaration & { name: ts.Identifier } =>
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
        if (["_startCollector", "_castCollector"].includes(field.name.text))
            declared.set(field, recordOf("QueryCollector"));
        values.set(field, {
            cpp: field.name.text,
            type: lowerer.declarationType(field),
            borrowed: "mutable",
        });
    }
    /** The parameters an earlier parameter's default reads. */
    const hasDependentDefault = (declaration: KernelDeclaration): boolean => {
        const preceding = new Set<ts.Declaration>();
        return declaration.parameters.some((parameter) => {
            const visit = (node: ts.Node): boolean => {
                if (ts.isIdentifier(node)) {
                    const target = context.declarationOf(node);
                    if (target && preceding.has(target)) return true;
                }
                return ts.forEachChild(node, visit) === true;
            };
            const dependent = parameter.initializer
                ? visit(parameter.initializer)
                : false;
            preceding.add(parameter);
            return dependent;
        });
    };
    /** The parameters a body stores to, which it therefore owns. */
    const reboundParameters = (
        declaration: KernelDeclaration | ts.ConstructorDeclaration,
    ): ReadonlySet<ts.Declaration> => {
        const rebound = new Set<ts.Declaration>();
        if (declaration.body)
            forEachAnalysisNode(
                declaration.body,
                (node) => {
                    const target = isAssignmentExpression(node)
                        ? node.left
                        : isUpdateExpression(node)
                          ? node.operand
                          : undefined;
                    const resolved =
                        target && ts.isIdentifier(target)
                            ? context.declarationOf(target)
                            : undefined;
                    if (resolved) rebound.add(resolved);
                },
                { functions: "skip", types: "skip" },
            );
        return rebound;
    };
    const parameterValues = (
        declaration: KernelDeclaration | ts.ConstructorDeclaration,
        types: readonly RecordShape[],
    ): Map<ts.Declaration, KernelValue> => {
        const locals = new Map(values);
        const rebound = reboundParameters(declaration);
        for (const [index, parameter] of declaration.parameters.entries()) {
            if (!ts.isIdentifier(parameter.name) || parameter.dotDotDotToken)
                return context.contractError(
                    parameter,
                    "Pinned controller parameter must be ordinary and named.",
                );
            locals.set(parameter, {
                cpp: parameter.name.text,
                type: types[index]!,
                borrowed: rebound.has(parameter) ? "mutable" : "stable",
            });
        }
        return locals;
    };
    const prototype = (
        declaration: KernelDeclaration,
        defaults: boolean,
        count = declaration.parameters.length,
    ): string => {
        const name = methodName(declaration);
        const fn = functions.get(declaration)!;
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
                return `[[maybe_unused]] ${parameterType} ${parameter.name.text}${nativeDefaults && initializer ? ` = ${lowerer.value(initializer, fn.parameters[index]).cpp}` : nativeDefaults && parameter.questionToken ? " = {}" : ""}`;
            });
        return `${lowerer.storage(fn.returns)} ${name}(${parameters.join(", ")})`;
    };
    const definition = (declaration: KernelDeclaration): string => {
        const name = methodName(declaration);
        const fn = functions.get(declaration)!;
        const body = new CharacterKernelLowerer(context, file, {
            ...schema,
            values: parameterValues(declaration, fn.parameters),
            returnType: fn.returns,
        });
        const source =
            full && name === "_castWithCollectors"
                ? lowerCharacterCollectorCasts(
                      context,
                      declaration as ts.MethodDeclaration,
                      body,
                  )
                : body.body(declaration.body!.statements, "    ");
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
                            ? body.value(parameter.initializer, type).cpp
                            : "{}";
                        return `    ${lowerer.storage(type)} ${parameter.name.getText(file)} = ${value};`;
                    });
                overloads.push(
                    `${prototype(declaration, false, count)} {\n${initializers.join("\n")}\n    return ${name}(${declaration.parameters.map((parameter) => parameter.name.getText(file)).join(", ")});\n}`,
                );
            }
        return `// ${context.provenance(characterControllerModule, ts.isMethodDeclaration(declaration) ? `PhysicsCharacterController.${name}` : name)}\n${prototype(declaration, ts.isMethodDeclaration(declaration))} {\n${source}\n}\n${overloads.join("\n")}`;
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
        const body = fields.find((field) => field.name.text === "_body")!;
        const bodyAssignments = context.findNodes(
            controller,
            (node): node is ts.BinaryExpression =>
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                ts.isPropertyAccessExpression(node.left) &&
                node.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
                resolvedSymbol(checker, node.left)?.valueDeclaration === body,
        );
        if (
            bodyAssignments.length !== 1 ||
            !ts.findAncestor(bodyAssignments[0], (node) => node === constructor)
        )
            return context.contractError(
                controller,
                "Pinned controller body ownership assignment changed.",
            );
        const initializer = new CharacterKernelLowerer(context, file, {
            ...schema,
            values: parameterValues(
                constructor,
                constructor.parameters.map((parameter) =>
                    lowerer.declarationType(parameter),
                ),
            ),
            ownedAssignments: new Set([body]),
        });
        initialize = `void initialize(const js::Ref<PhysicsWorld>& world, js::Ref<Vec3> position, js::Ref<PhysicsCharacterControllerOptions> options) {\n${initializer.body(constructor.body!.statements, "    ")}\n}`;
    }
    return `#pragma once
#include <bblite/pinned_records.hpp>
#include <tuple>
namespace bbl::character {
struct PhysicsBody;
struct NativeBody;
${full ? "struct PhysicsWorld; struct PhysicsShape; struct TransformNode; struct QueryCollector;" : ""}
${recordTypes.map((name) => `struct ${name};`).join("\n")}
${recordTypes.map((name) => `struct ${name} {\n${[...records.get(name)!].map(([field, type]) => `    ${lowerer.storage(type)} ${field}{};`).join("\n")}\n};`).join("\n")}
${helpers.map((declaration) => `inline ${prototype(declaration, true)};`).join("\n")}
${helpers.map((declaration) => `inline ${definition(declaration)}`).join("\n")}
${
    full
        ? `${lowerMat4InvertCpp(context, { inline: true, cppName: "_inverse_storage" })}
inline bbl::js::Nullable<js::Array<double>> _matrix_inverse(const js::Array<double>& input) {
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
    virtual bbl::js::Nullable<double> _body_identity(js::Ref<PhysicsBody>) = 0;
    virtual js::Ref<NativeBody> _native_body(js::Ref<PhysicsBody>) = 0;
    virtual bbl::js::Nullable<std::tuple<js::Ref<PhysicsBody>, js::Ref<NativeBody>, double>> _thin_resolve(bbl::js::Nullable<double>) = 0;
    virtual js::Ref<Vec3> _thin_com(js::Ref<PhysicsBody>, js::Ref<NativeBody>, js::Array<double>) = 0;
    virtual bbl::js::Nullable<js::Array<double>> _thin_matrix(js::Ref<PhysicsBody>, js::Ref<NativeBody>) = 0;
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
        const binding = values.get(field)!;
        return `    ${lowerer.storage(binding.type)} ${binding.cpp}${field.initializer ? ` = ${lowerer.value(field.initializer, binding.type).cpp}` : "{}"};`;
    })
    .join("\n")}
${methods.map(definition).join("\n")}
${initialize}
};
} // namespace bbl::character
`;
}
