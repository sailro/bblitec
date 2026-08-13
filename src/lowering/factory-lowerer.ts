import ts from "typescript";
import { LoweredSource, LoweringContext } from "./context.js";

export class FactoryLowerer {
    public constructor(private readonly context: LoweringContext) {}

    public lowerMeshFactories(): LoweredSource {
        const boxModule = "src/mesh/create-box.ts";
        const groundModule = "src/mesh/create-ground.ts";
        const planeModule = "src/mesh/create-plane.ts";
        const sphereModule = "src/mesh/create-sphere.ts";
        const torusModule = "src/mesh/create-torus.ts";
        const boxFile = this.context.sourceFile(boxModule);
        const { declaration: box } =
            this.context.functionDeclaration(
                boxModule,
                "createBoxData",
            );
        const { declaration: ground } =
            this.context.functionDeclaration(
                groundModule,
                "createFlatGroundData",
            );
        const { declaration: plane } =
            this.context.functionDeclaration(
                planeModule,
                "createPlaneData",
            );
        const { declaration: sphere } =
            this.context.functionDeclaration(
                sphereModule,
                "createSphereData",
            );
        const { file: torusFile, declaration: torus } =
            this.context.functionDeclaration(
                torusModule,
                "createTorusData",
            );
        const assertVariable = (
            root: ts.Node,
            name: string,
            expected: string,
            label: string,
        ): ts.Expression => {
            const expression =
                this.context.variableInitializer(root, name);
            this.context.assertExpressionShape(
                expression,
                expected,
                label,
            );
            return expression;
        };
        const indexedAssignments = (
            declaration: ts.FunctionDeclaration,
            arrayName: string,
        ): ts.BinaryExpression[] =>
            this.context
                .findNodes(
                    declaration,
                    (node): node is ts.BinaryExpression =>
                        ts.isBinaryExpression(node),
                )
                .filter(
                    (expression) =>
                        expression.operatorToken.kind ===
                            ts.SyntaxKind.EqualsToken &&
                        ts.isElementAccessExpression(
                            expression.left,
                        ) &&
                        ts.isIdentifier(
                            expression.left.expression,
                        ) &&
                        expression.left.expression.text ===
                            arrayName,
                );
        const numericConstructorArray = (
            file: ts.SourceFile,
            variableName: string,
            constructorName: string,
        ): {
            expression: ts.Expression;
            values: number[];
        } => {
            const expression =
                this.context.variableInitializer(
                    file,
                    variableName,
                );
            const unwrapped =
                this.context.unwrapExpression(expression);
            if (
                !ts.isNewExpression(unwrapped) ||
                !ts.isIdentifier(unwrapped.expression) ||
                unwrapped.expression.text !== constructorName ||
                unwrapped.arguments?.length !== 1 ||
                !ts.isArrayLiteralExpression(
                    unwrapped.arguments[0]!,
                )
            ) {
                this.context.contractError(
                    expression,
                    `Expected ${variableName} to be a ${constructorName} array.`,
                );
            }
            return {
                expression,
                values: unwrapped.arguments[0].elements.map(
                    (element) =>
                        this.context.numericValue(element, file),
                ),
            };
        };
        const assertNumbers = (
            expression: ts.Expression,
            actual: number[],
            expected: number[],
            label: string,
        ): void => {
            if (
                actual.length !== expected.length ||
                actual.some(
                    (value, index) =>
                        value !== expected[index],
                )
            ) {
                this.context.contractError(
                    expression,
                    `${label} changed.`,
                );
            }
        };

        assertVariable(
            boxFile,
            "BOX_POSITION_SIGNS",
            "[0x4b213fa5, 0xded6426f, 0x80]",
            "Box position signs",
        );
        const boxNormals = numericConstructorArray(
            boxFile,
            "BOX_NORMALS",
            "F32",
        );
        const expectedNormals = [
            [0, 0, 1],
            [0, 0, -1],
            [1, 0, 0],
            [-1, 0, 0],
            [0, 1, 0],
            [0, -1, 0],
        ].flatMap((normal) =>
            Array.from({ length: 4 }, () => normal).flat(),
        );
        assertNumbers(
            boxNormals.expression,
            boxNormals.values,
            expectedNormals,
            "Box face normals",
        );
        const boxUvs = numericConstructorArray(
            boxFile,
            "BOX_UVS",
            "F32",
        );
        assertNumbers(
            boxUvs.expression,
            boxUvs.values,
            Array.from(
                { length: 6 },
                () => [1, 1, 0, 1, 0, 0, 1, 0],
            ).flat(),
            "Box UVs",
        );
        const boxIndices = numericConstructorArray(
            boxFile,
            "BOX_INDICES",
            "U32",
        );
        assertNumbers(
            boxIndices.expression,
            boxIndices.values,
            Array.from({ length: 6 }, (_, face) => {
                const base = face * 4;
                return [
                    base,
                    base + 1,
                    base + 2,
                    base,
                    base + 2,
                    base + 3,
                ];
            }).flat(),
            "Box indices",
        );
        const boxBindings = this.context.findNodes(
            box,
            (node): node is ts.BindingElement =>
                ts.isBindingElement(node),
        );
        for (const [name, expected] of [
            ["size", "1"],
            ["width", "size"],
            ["height", "size"],
            ["depth", "size"],
        ] as const) {
            const binding = boxBindings.find(
                (candidate) =>
                    ts.isIdentifier(candidate.name) &&
                    candidate.name.text === name,
            );
            if (!binding?.initializer) {
                this.context.contractError(
                    box,
                    `Expected box binding '${name}'.`,
                );
            }
            this.context.assertExpressionShape(
                binding.initializer,
                expected,
                `Box '${name}' default`,
            );
        }
        const dimensions = this.context.findNodes(
            box,
            (node): node is ts.ElementAccessExpression =>
                ts.isElementAccessExpression(node) &&
                ts.isIdentifier(node.expression) &&
                node.expression.text === "dimensions",
        );
        if (dimensions.length !== 1) {
            this.context.contractError(
                box,
                "Expected one indexed box dimension lookup.",
            );
        }
        this.context.assertExpressionShape(
            dimensions[0]!,
            "dimensions[index % 3]",
            "Box dimension selection",
        );

        for (const [name, expected] of [
            ["width", "opts.width ?? 1"],
            ["height", "opts.height ?? 1"],
            ["subdivisions", "opts.subdivisions ?? 1"],
            ["uScale", "opts.uvScale?.[0] ?? 1"],
            ["vScale", "opts.uvScale?.[1] ?? 1"],
        ] as const) {
            assertVariable(
                ground,
                name,
                expected,
                `Ground '${name}'`,
            );
        }
        const groundIndices = indexedAssignments(
            ground,
            "indices",
        );
        const expectedGroundIndices = [
            "bottomRight",
            "topRight",
            "topLeft",
            "bottomLeft",
            "bottomRight",
            "topLeft",
        ];
        if (
            groundIndices.length !==
            expectedGroundIndices.length
        ) {
            this.context.contractError(
                ground,
                "Unexpected ground index count.",
            );
        }
        groundIndices.forEach((assignment, index) =>
            this.context.assertExpressionShape(
                assignment.right,
                expectedGroundIndices[index]!,
                `Ground index ${index}`,
            ),
        );

        for (const [name, expected] of [
            ["size", "options.size ?? 1"],
            ["width", "options.width ?? size"],
            ["height", "options.height ?? size"],
            [
                "positions",
                "new F32([-hw, -hh, 0, hw, -hh, 0, hw, hh, 0, -hw, hh, 0])",
            ],
            [
                "normals",
                "new F32([0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1])",
            ],
            [
                "uvs",
                "new F32([0, 0, 1, 0, 1, 1, 0, 1])",
            ],
            [
                "indices",
                "new U32([0, 1, 2, 0, 2, 3])",
            ],
        ] as const) {
            assertVariable(
                plane,
                name,
                expected,
                `Plane '${name}'`,
            );
        }

        for (const [name, expected] of [
            [
                "segments",
                "Math.max(3, options.segments ?? 32)",
            ],
            [
                "baseDiameter",
                "options.diameter ?? 1",
            ],
            [
                "rx",
                "(options.diameterX ?? baseDiameter) / 2",
            ],
            [
                "ry",
                "(options.diameterY ?? baseDiameter) / 2",
            ],
            [
                "rz",
                "(options.diameterZ ?? baseDiameter) / 2",
            ],
        ] as const) {
            assertVariable(
                sphere,
                name,
                expected,
                `Sphere '${name}'`,
            );
        }
        const spherePositions = indexedAssignments(
            sphere,
            "positions",
        );
        for (const [index, expected] of [
            [0, "rx * nx"],
            [1, "ry * ny"],
            [2, "rz * nz"],
        ] as const) {
            const assignment = spherePositions[index];
            if (!assignment) {
                this.context.contractError(
                    sphere,
                    `Missing sphere position component ${index}.`,
                );
            }
            this.context.assertExpressionShape(
                assignment.right,
                expected,
                `Sphere position component ${index}`,
            );
        }

        const torusDiameterExpression = assertVariable(
            torus,
            "diameter",
            "opts.diameter ?? 1",
            "Torus diameter",
        );
        const torusThicknessExpression = assertVariable(
            torus,
            "thickness",
            "opts.thickness ?? 0.5",
            "Torus thickness",
        );
        const torusTessellationExpression = assertVariable(
            torus,
            "tessellation",
            "opts.tessellation ?? 16",
            "Torus tessellation",
        );
        assertVariable(
            torus,
            "outerAngle",
            "(i * TWO_PI) / tessellation - Math.PI / 2",
            "Torus outer angle",
        );
        assertVariable(
            torus,
            "innerAngle",
            "(j * TWO_PI) / tessellation + Math.PI",
            "Torus inner angle",
        );
        const torusIndices = indexedAssignments(
            torus,
            "indices",
        );
        const expectedTorusIndices = [
            "i * stride + j",
            "i * stride + nextJ",
            "nextI * stride + j",
            "i * stride + nextJ",
            "nextI * stride + nextJ",
            "nextI * stride + j",
        ];
        if (
            torusIndices.length !==
            expectedTorusIndices.length
        ) {
            this.context.contractError(
                torus,
                "Unexpected torus index count.",
            );
        }
        torusIndices.forEach((assignment, index) =>
            this.context.assertExpressionShape(
                assignment.right,
                expectedTorusIndices[index]!,
                `Torus index ${index}`,
            ),
        );
        const numericNullishFallback = (
            expression: ts.Expression,
        ): number => {
            const unwrapped =
                this.context.unwrapExpression(expression);
            if (
                !ts.isBinaryExpression(unwrapped) ||
                unwrapped.operatorToken.kind !==
                    ts.SyntaxKind.QuestionQuestionToken
            ) {
                this.context.contractError(
                    expression,
                    "Expected a numeric nullish default.",
                );
            }
            return this.context.numericValue(
                unwrapped.right,
                torusFile,
            );
        };
        const torusDiameter = numericNullishFallback(
            torusDiameterExpression,
        );
        const torusThickness = numericNullishFallback(
            torusThicknessExpression,
        );
        const torusTessellation = numericNullishFallback(
            torusTessellationExpression,
        );
        const modulePath = "src/mesh/mesh-factories.ts";
        const { declaration: meshFromData } =
            this.context.functionDeclaration(
                modulePath,
                "createMeshFromData",
            );
        const aabbCall = this.context.findNodes(
            meshFromData,
            (node): node is ts.CallExpression =>
                ts.isCallExpression(node) &&
                ts.isIdentifier(node.expression) &&
                node.expression.text === "computeAabb",
        )[0];
        if (!aabbCall) {
            this.context.contractError(
                meshFromData,
                "Expected createMeshFromData to fold bounds through computeAabb.",
            );
        }
        this.context.functionDeclaration(
            "src/math/compute-aabb.ts",
            "computeAabb",
        );
        this.context.functionDeclaration(
            "src/mesh/thin-instance.ts",
            "setThinInstances",
        );
        const value = (input: number): string => this.context.floatLiteral(input);
        return {
            modulePath,
            symbolName: "createBox,createGround,createPlane,createSphere,createTorus,createMeshFromData",
            header: "",
            source: `// ${this.context.provenance(
                modulePath,
                "createBox, createGround, createPlane, createSphere, createTorus, createMeshFromData",
                "src/mesh/create-box.ts, src/mesh/create-ground.ts, src/mesh/create-plane.ts, src/mesh/create-sphere.ts, src/mesh/create-torus.ts defaults, and src/math/compute-aabb.ts bounds folding",
            )}
#include <bblite/runtime.hpp>

#include <algorithm>
#include <cmath>
#include <limits>
#include <utility>

namespace bbl {

MeshHandle create_box(Engine& engine, BoxOptions options) {
    const float width = options.width;
    const float height = options.height;
    const float depth = options.depth;
    const float half_width = width * 0.5f;
    const float half_height = height * 0.5f;
    const float half_depth = depth * 0.5f;
    ModelGeometry geometry;
    const auto add_face = [&](
                              Vec3 a,
                              Vec3 b,
                              Vec3 c,
                              Vec3 d,
                              Vec3 normal) {
        geometry.vertices.insert(
            geometry.vertices.end(),
            {
                ModelVertex{a, normal, Vec4{1.0f, 0.0f, 0.0f, 1.0f}, Vec2{1.0f, 1.0f}},
                ModelVertex{b, normal, Vec4{1.0f, 0.0f, 0.0f, 1.0f}, Vec2{0.0f, 1.0f}},
                ModelVertex{c, normal, Vec4{1.0f, 0.0f, 0.0f, 1.0f}, Vec2{0.0f, 0.0f}},
                ModelVertex{d, normal, Vec4{1.0f, 0.0f, 0.0f, 1.0f}, Vec2{1.0f, 0.0f}},
            });
        const std::uint32_t start =
            static_cast<std::uint32_t>(geometry.vertices.size() - 4);
        geometry.indices.insert(
            geometry.indices.end(),
            {start, start + 1, start + 2, start, start + 2, start + 3});
    };
    add_face(
        Vec3{half_width, -half_height, half_depth},
        Vec3{-half_width, -half_height, half_depth},
        Vec3{-half_width, half_height, half_depth},
        Vec3{half_width, half_height, half_depth},
        Vec3{0.0f, 0.0f, 1.0f});
    add_face(
        Vec3{half_width, half_height, -half_depth},
        Vec3{-half_width, half_height, -half_depth},
        Vec3{-half_width, -half_height, -half_depth},
        Vec3{half_width, -half_height, -half_depth},
        Vec3{0.0f, 0.0f, -1.0f});
    add_face(
        Vec3{half_width, half_height, -half_depth},
        Vec3{half_width, -half_height, -half_depth},
        Vec3{half_width, -half_height, half_depth},
        Vec3{half_width, half_height, half_depth},
        Vec3{1.0f, 0.0f, 0.0f});
    add_face(
        Vec3{-half_width, half_height, half_depth},
        Vec3{-half_width, -half_height, half_depth},
        Vec3{-half_width, -half_height, -half_depth},
        Vec3{-half_width, half_height, -half_depth},
        Vec3{-1.0f, 0.0f, 0.0f});
    add_face(
        Vec3{-half_width, half_height, half_depth},
        Vec3{-half_width, half_height, -half_depth},
        Vec3{half_width, half_height, -half_depth},
        Vec3{half_width, half_height, half_depth},
        Vec3{0.0f, 1.0f, 0.0f});
    add_face(
        Vec3{half_width, -half_height, half_depth},
        Vec3{half_width, -half_height, -half_depth},
        Vec3{-half_width, -half_height, -half_depth},
        Vec3{-half_width, -half_height, half_depth},
        Vec3{0.0f, -1.0f, 0.0f});
    geometry.bounds_min =
        Vec3{-half_width, -half_height, -half_depth};
    geometry.bounds_max =
        Vec3{half_width, half_height, half_depth};
    for (ModelVertex& vertex : geometry.vertices) {
        vertex.local_position = vertex.position;
    }
    engine.geometries.push_back(std::move(geometry));
    MeshRecord mesh;
    mesh.primitive = PrimitiveKind::box;
    mesh.dimensions = Vec3{width, height, depth};
    mesh.geometry =
        static_cast<std::uint32_t>(engine.geometries.size() - 1);
    engine.meshes.push_back(mesh);
    return MeshHandle{static_cast<std::uint32_t>(engine.meshes.size() - 1)};
}

MeshHandle create_ground(Engine& engine, GroundOptions options) {
    const float width = options.width;
    const float height = options.height;
    const std::uint32_t subdivisions =
        std::max<std::uint32_t>(1, options.subdivisions);
    const std::uint32_t columns = subdivisions + 1;
    const float half_width = width * 0.5f;
    const float half_height = height * 0.5f;
    ModelGeometry geometry;
    geometry.vertices.reserve(
        static_cast<std::size_t>(columns) * columns);
    geometry.indices.reserve(
        static_cast<std::size_t>(subdivisions) *
        subdivisions *
        6);
    for (std::uint32_t row = 0; row <= subdivisions; ++row) {
        const float normalized_row =
            static_cast<float>(row) /
            static_cast<float>(subdivisions);
        for (
            std::uint32_t column = 0;
            column <= subdivisions;
            ++column) {
            const float normalized_column =
                static_cast<float>(column) /
                static_cast<float>(subdivisions);
            geometry.vertices.push_back(ModelVertex{
                Vec3{
                    -half_width + normalized_column * width,
                    0.0f,
                    -half_height +
                        (1.0f - normalized_row) * height,
                },
                Vec3{0.0f, 1.0f, 0.0f},
                Vec4{1.0f, 0.0f, 0.0f, 1.0f},
                Vec2{
                    normalized_column * options.uv_scale.x,
                    (1.0f - normalized_row) *
                        options.uv_scale.y,
                },
            });
        }
    }
    for (std::uint32_t row = 0; row < subdivisions; ++row) {
        for (
            std::uint32_t column = 0;
            column < subdivisions;
            ++column) {
            const std::uint32_t top_left =
                row * columns + column;
            const std::uint32_t top_right = top_left + 1;
            const std::uint32_t bottom_left =
                (row + 1) * columns + column;
            const std::uint32_t bottom_right =
                bottom_left + 1;
            geometry.indices.insert(
                geometry.indices.end(),
                {
                    bottom_right,
                    top_right,
                    top_left,
                    bottom_left,
                    bottom_right,
                    top_left,
                });
        }
    }
    geometry.bounds_min = Vec3{-half_width, 0.0f, -half_height};
    geometry.bounds_max = Vec3{half_width, 0.0f, half_height};
    for (ModelVertex& vertex : geometry.vertices) {
        vertex.local_position = vertex.position;
    }
    engine.geometries.push_back(std::move(geometry));
    MeshRecord mesh;
    mesh.primitive = PrimitiveKind::ground;
    mesh.dimensions = Vec3{width, 0.0f, height};
    mesh.geometry =
        static_cast<std::uint32_t>(engine.geometries.size() - 1);
    engine.meshes.push_back(mesh);
    return MeshHandle{static_cast<std::uint32_t>(engine.meshes.size() - 1)};
}

MeshHandle create_plane(Engine& engine, PlaneOptions options) {
    const float half_width = options.width * 0.5f;
    const float half_height = options.height * 0.5f;
    ModelGeometry geometry;
    geometry.vertices = {
        ModelVertex{
            Vec3{-half_width, -half_height, 0.0f},
            Vec3{0.0f, 0.0f, -1.0f},
            Vec4{1.0f, 0.0f, 0.0f, 1.0f},
            Vec2{0.0f, 0.0f}},
        ModelVertex{
            Vec3{half_width, -half_height, 0.0f},
            Vec3{0.0f, 0.0f, -1.0f},
            Vec4{1.0f, 0.0f, 0.0f, 1.0f},
            Vec2{1.0f, 0.0f}},
        ModelVertex{
            Vec3{half_width, half_height, 0.0f},
            Vec3{0.0f, 0.0f, -1.0f},
            Vec4{1.0f, 0.0f, 0.0f, 1.0f},
            Vec2{1.0f, 1.0f}},
        ModelVertex{
            Vec3{-half_width, half_height, 0.0f},
            Vec3{0.0f, 0.0f, -1.0f},
            Vec4{1.0f, 0.0f, 0.0f, 1.0f},
            Vec2{0.0f, 1.0f}},
    };
    geometry.indices = {0, 1, 2, 0, 2, 3};
    geometry.bounds_min = Vec3{-half_width, -half_height, 0.0f};
    geometry.bounds_max = Vec3{half_width, half_height, 0.0f};
    for (ModelVertex& vertex : geometry.vertices) {
        vertex.local_position = vertex.position;
    }
    engine.geometries.push_back(std::move(geometry));
    MeshRecord mesh;
    mesh.primitive = PrimitiveKind::gltf;
    mesh.geometry = static_cast<std::uint32_t>(engine.geometries.size() - 1);
    engine.meshes.push_back(mesh);
    return MeshHandle{static_cast<std::uint32_t>(engine.meshes.size() - 1)};
}

MeshHandle create_sphere(Engine& engine, SphereOptions options) {
    const std::uint32_t segments =
        std::max<std::uint32_t>(3, options.segments);
    const Vec3 radius{
        options.diameter_x * 0.5f,
        options.diameter_y * 0.5f,
        options.diameter_z * 0.5f,
    };
    const std::uint32_t z_steps = 2 + segments;
    const std::uint32_t y_steps = 2 * z_steps;
    ModelGeometry geometry;
    geometry.vertices.reserve(
        static_cast<std::size_t>(z_steps + 1) * (y_steps + 1));
    geometry.indices.reserve(
        static_cast<std::size_t>(z_steps) * y_steps * 6);
    for (std::uint32_t z_step = 0; z_step <= z_steps; ++z_step) {
        const float normalized_z =
            static_cast<float>(z_step) / static_cast<float>(z_steps);
        const float angle_z = normalized_z * pi;
        for (std::uint32_t y_step = 0; y_step <= y_steps; ++y_step) {
            const float normalized_y =
                static_cast<float>(y_step) / static_cast<float>(y_steps);
            const float angle_y = normalized_y * pi * 2.0f;
            const Vec3 normal{
                std::sin(angle_z) * std::cos(angle_y),
                std::cos(angle_z),
                -std::sin(angle_z) * std::sin(angle_y),
            };
            geometry.vertices.push_back(ModelVertex{
                Vec3{
                    radius.x * normal.x,
                    radius.y * normal.y,
                    radius.z * normal.z,
                },
                normal,
                Vec4{1.0f, 0.0f, 0.0f, 1.0f},
                Vec2{normalized_y, normalized_z},
            });
        }

    }
    for (std::uint32_t z_step = 0; z_step < z_steps; ++z_step) {
        for (std::uint32_t y_step = 0; y_step < y_steps; ++y_step) {
            const std::uint32_t a = z_step * (y_steps + 1) + y_step;
            const std::uint32_t b = a + y_steps + 1;
            geometry.indices.insert(
                geometry.indices.end(),
                {a, a + 1, b, b, a + 1, b + 1});
        }
    }
    geometry.bounds_min =
        Vec3{-radius.x, -radius.y, -radius.z};
    geometry.bounds_max =
        Vec3{radius.x, radius.y, radius.z};
    for (ModelVertex& vertex : geometry.vertices) {
        vertex.local_position = vertex.position;
    }
    engine.geometries.push_back(std::move(geometry));
    MeshRecord mesh;
    mesh.primitive = PrimitiveKind::sphere;
    mesh.dimensions = Vec3{
        options.diameter_x,
        options.diameter_y,
        options.diameter_z,
    };
    mesh.geometry = static_cast<std::uint32_t>(engine.geometries.size() - 1);
    engine.meshes.push_back(mesh);
    return MeshHandle{static_cast<std::uint32_t>(engine.meshes.size() - 1)};
}

MeshHandle create_torus(Engine& engine, TorusOptions options) {
    const float diameter =
        options.diameter > 0.0f ? options.diameter : ${value(torusDiameter)};
    const float thickness =
        options.thickness > 0.0f ? options.thickness : ${value(torusThickness)};
    const std::uint32_t tessellation = std::max<std::uint32_t>(
        3,
        options.tessellation > 0 ? options.tessellation : ${torusTessellation}u);
    const float major_radius = diameter * 0.5f;
    const float minor_radius = thickness * 0.5f;
    const std::uint32_t stride = tessellation + 1;
    ModelGeometry geometry;
    geometry.vertices.reserve(
        static_cast<std::size_t>(stride) * stride);
    geometry.indices.reserve(
        static_cast<std::size_t>(stride) * stride * 6);
    for (std::uint32_t outer_index = 0;
         outer_index <= tessellation;
         ++outer_index) {
        const float outer_angle =
            static_cast<float>(outer_index) * 2.0f * pi /
                static_cast<float>(tessellation) -
            pi * 0.5f;
        const float cos_outer = std::cos(outer_angle);
        const float sin_outer = std::sin(outer_angle);
        for (std::uint32_t inner_index = 0;
             inner_index <= tessellation;
             ++inner_index) {
            const float inner_angle =
                static_cast<float>(inner_index) * 2.0f * pi /
                    static_cast<float>(tessellation) +
                pi;
            const float dx = std::cos(inner_angle);
            const float dy = std::sin(inner_angle);
            const Vec3 position{
                (dx * minor_radius + major_radius) * cos_outer,
                dy * minor_radius,
                -(dx * minor_radius + major_radius) * sin_outer,
            };
            geometry.vertices.push_back(ModelVertex{
                position,
                Vec3{dx * cos_outer, dy, -dx * sin_outer},
                Vec4{1.0f, 0.0f, 0.0f, 1.0f},
                Vec2{
                    static_cast<float>(outer_index) /
                        static_cast<float>(tessellation),
                    1.0f -
                        static_cast<float>(inner_index) /
                            static_cast<float>(tessellation),
                },
                {},
                position,
            });
            const std::uint32_t next_outer =
                (outer_index + 1) % stride;
            const std::uint32_t next_inner =
                (inner_index + 1) % stride;
            geometry.indices.insert(
                geometry.indices.end(),
                {
                    outer_index * stride + inner_index,
                    outer_index * stride + next_inner,
                    next_outer * stride + inner_index,
                    outer_index * stride + next_inner,
                    next_outer * stride + next_inner,
                    next_outer * stride + inner_index,
                });
        }
    }
    const float outer_radius = major_radius + minor_radius;
    geometry.bounds_min =
        Vec3{-outer_radius, -minor_radius, -outer_radius};
    geometry.bounds_max =
        Vec3{outer_radius, minor_radius, outer_radius};
    for (ModelVertex& vertex : geometry.vertices) {
        vertex.local_position = vertex.position;
    }
    engine.geometries.push_back(std::move(geometry));
    MeshRecord mesh;
    mesh.primitive = PrimitiveKind::torus;
    mesh.geometry =
        static_cast<std::uint32_t>(engine.geometries.size() - 1);
    engine.meshes.push_back(mesh);
    return MeshHandle{
        static_cast<std::uint32_t>(engine.meshes.size() - 1)};
}

MeshHandle create_mesh_from_data(
    Engine& engine,
    const std::vector<float>& positions,
    const std::vector<float>& normals,
    const std::vector<std::uint32_t>& indices,
    const std::vector<float>& uvs,
    const std::vector<float>& uvs2,
    const std::vector<float>& tangents,
    const std::vector<float>& colors) {
    const std::size_t vertex_count = positions.size() / 3;
    ModelGeometry geometry;
    geometry.vertices.resize(vertex_count);
    for (std::size_t index = 0; index < vertex_count; ++index) {
        ModelVertex& vertex = geometry.vertices[index];
        vertex.position = Vec3{
            positions[index * 3],
            positions[index * 3 + 1],
            positions[index * 3 + 2]};
        if (normals.size() >= index * 3 + 3) {
            vertex.normal = Vec3{
                normals[index * 3],
                normals[index * 3 + 1],
                normals[index * 3 + 2]};
        }
        if (uvs.size() >= index * 2 + 2) {
            vertex.uv = Vec2{uvs[index * 2], uvs[index * 2 + 1]};
        }
        if (uvs2.size() >= index * 2 + 2) {
            vertex.uv2 = Vec2{uvs2[index * 2], uvs2[index * 2 + 1]};
        }
        if (tangents.size() >= index * 4 + 4) {
            vertex.tangent = Vec4{
                tangents[index * 4],
                tangents[index * 4 + 1],
                tangents[index * 4 + 2],
                tangents[index * 4 + 3]};
        }
        if (colors.size() >= index * 4 + 4) {
            vertex.color = Vec4{
                colors[index * 4],
                colors[index * 4 + 1],
                colors[index * 4 + 2],
                colors[index * 4 + 3]};
        }
        vertex.local_position = vertex.position;
    }
    geometry.indices = indices;
    geometry.has_tangents = !tangents.empty();
    // computeAabb: fold XYZ min/max over the positions buffer; empty input
    // keeps the record's default bounds (the pinned helper returns
    // infinities that createMeshFromData filters through isFinite).
    if (vertex_count > 0) {
        Vec3 bounds_min{
            std::numeric_limits<float>::infinity(),
            std::numeric_limits<float>::infinity(),
            std::numeric_limits<float>::infinity()};
        Vec3 bounds_max{
            -std::numeric_limits<float>::infinity(),
            -std::numeric_limits<float>::infinity(),
            -std::numeric_limits<float>::infinity()};
        for (std::size_t index = 0; index < vertex_count; ++index) {
            const Vec3 position = geometry.vertices[index].position;
            bounds_min.x = std::min(bounds_min.x, position.x);
            bounds_min.y = std::min(bounds_min.y, position.y);
            bounds_min.z = std::min(bounds_min.z, position.z);
            bounds_max.x = std::max(bounds_max.x, position.x);
            bounds_max.y = std::max(bounds_max.y, position.y);
            bounds_max.z = std::max(bounds_max.z, position.z);
        }
        geometry.bounds_min = bounds_min;
        geometry.bounds_max = bounds_max;
    }
    engine.geometries.push_back(std::move(geometry));
    MeshRecord mesh;
    mesh.primitive = PrimitiveKind::gltf;
    mesh.geometry =
        static_cast<std::uint32_t>(engine.geometries.size() - 1);
    engine.meshes.push_back(mesh);
    return MeshHandle{
        static_cast<std::uint32_t>(engine.meshes.size() - 1)};
}

// src/mesh/thin-instance.ts setThinInstances: adopt the caller's matrix
// array and active count. The reached subset sets count == capacity; the
// record's own transform stays identity like the demo prototypes.
void set_thin_instances(
    Engine& engine,
    MeshHandle mesh,
    const std::vector<float>& matrices,
    double count) {
    MeshRecord& record = engine.meshes[mesh.value];
    const std::size_t available = matrices.size() / 16;
    const std::size_t instance_count = std::min(
        static_cast<std::size_t>(count),
        available);
    record.instance_matrices.assign(
        instance_count,
        std::array<float, 16>{});
    for (std::size_t index = 0; index < instance_count; ++index) {
        std::copy_n(
            matrices.data() + index * 16,
            16,
            record.instance_matrices[index].data());
    }
}

} // namespace bbl
`,
        };
    }

    public lowerShaderMaterialFactory(): LoweredSource {
        const modulePath = "src/material/shader/shader-material.ts";
        const { declaration } =
            this.context.functionDeclaration(
                modulePath,
                "createShaderMaterial",
            );
        const isNullishDefault = (
            expression: ts.Expression,
            leftPath: string,
            fallback: (value: ts.Expression) => boolean,
        ): boolean => {
            const unwrapped =
                this.context.unwrapExpression(expression);
            return (
                ts.isBinaryExpression(unwrapped) &&
                unwrapped.operatorToken.kind ===
                    ts.SyntaxKind.QuestionQuestionToken &&
                this.context
                    .propertyPath(unwrapped.left)
                    ?.join(".") === leftPath &&
                fallback(unwrapped.right)
            );
        };
        const needAlphaBlending =
            this.context.variableInitializer(
                declaration,
                "needAlphaBlending",
            );
        if (
            !isNullishDefault(
                needAlphaBlending,
                "options.needAlphaBlending",
                (fallback) =>
                    ts.isPrefixUnaryExpression(fallback) &&
                    fallback.operator ===
                        ts.SyntaxKind.ExclamationToken &&
                    ts.isPrefixUnaryExpression(
                        fallback.operand,
                    ) &&
                    fallback.operand.operator ===
                        ts.SyntaxKind.ExclamationToken &&
                    this.context
                        .propertyPath(
                            fallback.operand.operand,
                        )
                        ?.join(".") === "options.blend",
            )
        ) {
            this.context.contractError(
                needAlphaBlending,
                "Expected alpha blending to fall back to the blend state.",
            );
        }
        const returned = this.context.returnObject(declaration);
        for (const contract of [
            {
                property: "needAlphaTesting",
                path: "options.needAlphaTesting",
                fallback: (value: ts.Expression): boolean =>
                    value.kind ===
                    ts.SyntaxKind.FalseKeyword,
            },
            {
                property: "backFaceCulling",
                path: "options.backFaceCulling",
                fallback: (value: ts.Expression): boolean =>
                    value.kind === ts.SyntaxKind.TrueKeyword,
            },
            {
                property: "depthWrite",
                path: "options.depthWrite",
                fallback: (value: ts.Expression): boolean =>
                    ts.isPrefixUnaryExpression(value) &&
                    value.operator ===
                        ts.SyntaxKind.ExclamationToken &&
                    ts.isIdentifier(value.operand) &&
                    value.operand.text ===
                        "needAlphaBlending",
            },
        ]) {
            const expression =
                this.context.propertyInitializer(
                    returned,
                    contract.property,
                );
            if (
                !isNullishDefault(
                    expression,
                    contract.path,
                    contract.fallback,
                )
            ) {
                this.context.contractError(
                    expression,
                    `Unexpected '${contract.property}' default.`,
                );
            }
        }
        return {
            modulePath,
            symbolName:
                "createShaderMaterial,setShaderUniform,setShaderFloat,setShaderVector3,setAlphaToCoverage",
            header: "",
            source: `// ${this.context.provenance(modulePath, "createShaderMaterial")}
#include <bblite/runtime.hpp>

#include <stdexcept>

namespace bbl {

MaterialHandle create_shader_material(
    Engine& engine,
    ShaderMaterialVariant variant) {
    MaterialRecord material;
    material.shader_material = true;
    material.shader_variant = variant;
    switch (variant) {
        case ShaderMaterialVariant::alpha_card:
            material.double_sided = true;
            material.shader_depth_write = true;
            break;
        case ShaderMaterialVariant::circular_cutout:
            material.alpha_mode = MaterialAlphaMode::blend;
            material.double_sided = true;
            material.shader_alpha_testing = true;
            material.shader_depth_write = false;
            break;
    }
    engine.materials.push_back(material);
    return MaterialHandle{static_cast<std::uint32_t>(engine.materials.size() - 1)};
}

MaterialRecord& shader_material(Engine& engine, MaterialHandle handle) {
    if (handle.value >= engine.materials.size()) {
        throw std::runtime_error("Invalid shader material handle.");
    }
    MaterialRecord& material = engine.materials[handle.value];
    if (!material.shader_material) {
        throw std::runtime_error("Material is not a shader material.");
    }
    if (material.shader_variant != ShaderMaterialVariant::alpha_card) {
        throw std::runtime_error(
            "Shader uniforms are unsupported for this reached shader variant.");
    }
    return material;
}

void set_shader_center(Engine& engine, MaterialHandle material, Vec2 value) {
    shader_material(engine, material).shader_center = value;
}

void set_shader_float(
    Engine& engine,
    MaterialHandle material,
    const std::string& name,
    float value) {
    MaterialRecord& record = shader_material(engine, material);
    if (name == "angle") record.shader_angle = value;
    else if (name == "depth") record.shader_depth = value;
    else if (name == "opacity") record.shader_opacity = value;
    else throw std::runtime_error("Unsupported shader float uniform: " + name);
}

void set_shader_vector3(
    Engine& engine,
    MaterialHandle material,
    const std::string& name,
    Color3 value) {
    if (name != "color") {
        throw std::runtime_error("Unsupported shader vec3 uniform: " + name);
    }
    shader_material(engine, material).shader_color = value;
}

void set_alpha_to_coverage(
    Engine& engine,
    MaterialHandle material,
    bool enabled) {
    shader_material(engine, material).alpha_to_coverage = enabled;
}

} // namespace bbl
`,
        };
    }

    public lowerPbrMaterialFactory(): LoweredSource {
        const solidModule = "src/texture/solid-texture.ts";
        const pbrModule = "src/material/pbr/pbr-material.ts";
        const { declaration: createSolidTexture } =
            this.context.functionDeclaration(
                solidModule,
                "createSolidTexture2D",
            );
        const quantizedChannels = this.context.countNodes(
            createSolidTexture,
            (node) =>
                ts.isCallExpression(node) &&
                ts.isPropertyAccessExpression(
                    node.expression,
                ) &&
                ts.isIdentifier(
                    node.expression.expression,
                ) &&
                node.expression.expression.text === "Math" &&
                node.expression.name.text === "round" &&
                node.arguments.length === 1 &&
                ts.isBinaryExpression(node.arguments[0]!) &&
                node.arguments[0].operatorToken.kind ===
                    ts.SyntaxKind.AsteriskToken &&
                ts.isNumericLiteral(
                    node.arguments[0].right,
                ) &&
                Number(node.arguments[0].right.text) === 255,
        );
        if (quantizedChannels !== 4) {
            this.context.contractError(
                createSolidTexture,
                `Expected four 8-bit quantized channels, found ${quantizedChannels}.`,
            );
        }
        if (
            !this.context.hasNode(
                createSolidTexture,
                (node) =>
                    ts.isPropertyAssignment(node) &&
                    this.context.propertyName(node.name) ===
                        "format" &&
                    ts.isStringLiteral(node.initializer) &&
                    node.initializer.text === "rgba8unorm",
            )
        ) {
            this.context.contractError(
                createSolidTexture,
                "Expected rgba8unorm solid textures.",
            );
        }
        const { declaration: createPbrMaterial } =
            this.context.functionDeclaration(
                pbrModule,
                "createPbrMaterial",
            );
        const returned =
            this.context.returnObject(createPbrMaterial);
        if (
            !returned.properties.some(
                (property) =>
                    ts.isSpreadAssignment(property) &&
                    ts.isIdentifier(property.expression) &&
                    property.expression.text === "props",
            )
        ) {
            this.context.contractError(
                returned,
                "Expected PBR props to be preserved.",
            );
        }
        const uboVersion = this.context.propertyInitializer(
            returned,
            "_uboVersion",
        );
        if (
            !ts.isNumericLiteral(uboVersion) ||
            Number(uboVersion.text) !== 0
        ) {
            this.context.contractError(
                uboVersion,
                "Expected initial PBR UBO version 0.",
            );
        }
        this.context.functionDeclaration(
            "src/texture/texture-2d.ts",
            "loadTexture2D",
        );
        return {
            modulePath: pbrModule,
            symbolName: "createPbrMaterial,createSolidTexture2D,loadTexture2D",
            header: "",
            source: `// ${this.context.provenance(
                pbrModule,
                "createPbrMaterial",
                `${solidModule}#createSolidTexture2D, src/texture/texture-2d.ts#loadTexture2D`,
            )}
#include <bblite/runtime.hpp>
#include <bblite/pal.hpp>

#include <algorithm>
#include <cmath>
#include <utility>

namespace bbl {

// src/texture/texture-2d.ts loadTexture2D: the encoded image bytes load at
// startup (the compiler materialized the asset), and the sampler mirrors the
// pinned defaults (linear filters, repeat addressing, invertY true, srgb
// false; mip sampling clamps to the base level when mipMaps is false).
FileTexture load_file_texture(
    Engine&,
    const std::string& path,
    TextureSamplerState sampler,
    bool invert_y,
    bool srgb) {
    FileTexture texture;
    texture.data.bytes = pal::read_binary_file(path);
    texture.data.sampler = sampler;
    texture.data.invert_y = invert_y;
    texture.srgb = srgb;
    return texture;
}

// Attaches a loaded base-color image to a created PBR material. The base
// color slot always samples sRGB natively, matching the srgb: true contract
// the compiler validated at the call site.
void set_material_base_color_file(
    Engine& engine,
    MaterialHandle material,
    FileTexture texture) {
    engine.materials[material.value].base_color_texture =
        std::move(texture.data);
}

SolidTexture create_solid_texture(
    Engine&,
    float r,
    float g,
    float b,
    float a) {
    const auto quantize = [](float value) {
        return static_cast<float>(
            std::lround(std::clamp(value, 0.0f, 1.0f) * 255.0f)) / 255.0f;
    };
    return SolidTexture{Color4{
        quantize(r),
        quantize(g),
        quantize(b),
        quantize(a),
    }};
}

MaterialHandle create_pbr_material(
    Engine& engine,
    PbrMaterialOptions options) {
    MaterialRecord material;
    material.base_color_factor = options.base_color.color;
    material.roughness_factor =
        options.orm.color.g * options.roughness_factor;
    material.metallic_factor =
        options.orm.color.b * options.metallic_factor;
    material.direct_intensity = options.direct_intensity;
    material.environment_intensity = options.environment_intensity;
    material.base_color_factor.a = options.alpha;
    material.reflectance = options.reflectance;
    material.alpha_mode =
        options.alpha < 1.0f
            ? MaterialAlphaMode::blend
            : MaterialAlphaMode::opaque;
    material.unlit = options.unlit;
    material.double_sided = options.double_sided;
    material.skybox_mode = options.skybox_mode;
    material.transmission_factor = options.transmission_factor;
    material.index_of_refraction = options.index_of_refraction;
    material.thickness = options.thickness;
    material.use_thickness_as_depth = options.use_thickness_as_depth;
    material.attenuation_color = options.attenuation_color;
    material.attenuation_distance = options.attenuation_distance;
    material.has_ior = false;
    material.has_volume = options.has_volume;
    if (material.transmission_factor > 0.0f) {
        material.alpha_mode = MaterialAlphaMode::blend;
    }
    material.has_occlusion_texture = true;
    engine.materials.push_back(material);
    return MaterialHandle{static_cast<std::uint32_t>(engine.materials.size() - 1)};
}

} // namespace bbl
`,
        };
    }

    public lowerGridMaterialFactory(): LoweredSource {
        const modulePath = "src/material/grid/grid-material.ts";
        const { file, declaration } =
            this.context.functionDeclaration(
                modulePath,
                "createGridMaterial",
            );
        for (const [name, path, expected] of [
            [
                "mainColor",
                "options.mainColor",
                [0, 0, 0],
            ],
            [
                "lineColor",
                "options.lineColor",
                [0, 0.5, 0.5],
            ],
        ] as const) {
            const initializer =
                this.context.unwrapExpression(
                    this.context.variableInitializer(
                        declaration,
                        name,
                    ),
                );
            if (
                !ts.isBinaryExpression(initializer) ||
                initializer.operatorToken.kind !==
                    ts.SyntaxKind.QuestionQuestionToken ||
                this.context
                    .propertyPath(initializer.left)
                    ?.join(".") !== path
            ) {
                this.context.contractError(
                    initializer,
                    `Unexpected '${name}' default expression.`,
                );
            }
            const values = this.context.numericTuple(
                initializer.right,
                file,
            );
            if (
                values.some(
                    (value, index) =>
                        value !== expected[index],
                )
            ) {
                this.context.contractError(
                    initializer.right,
                    `Unexpected '${name}' default value.`,
                );
            }
        }
        this.context.assertExpressionShape(
            this.context.variableInitializer(
                declaration,
                "gridControl",
            ),
            "[gridRatio, Math.round(majorUnitFrequency), minorUnitVisibility, opacity]",
            "GridMaterial control vector",
        );
        const transparent = this.context.unwrapExpression(
            this.context.variableInitializer(
                declaration,
                "transparent",
            ),
        );
        if (
            !ts.isBinaryExpression(transparent) ||
            transparent.operatorToken.kind !==
                ts.SyntaxKind.LessThanToken ||
            !ts.isIdentifier(transparent.left) ||
            transparent.left.text !== "opacity" ||
            !ts.isNumericLiteral(transparent.right) ||
            Number(transparent.right.text) !== 1
        ) {
            this.context.contractError(
                transparent,
                "Expected opacity below one to select transparency.",
            );
        }
        const shaderOptions =
            this.context.callObjectArgument(
                declaration,
                "createShaderMaterial",
            );
        const alphaBlending =
            this.context.propertyInitializer(
                shaderOptions,
                "needAlphaBlending",
            );
        if (
            !ts.isBinaryExpression(alphaBlending) ||
            alphaBlending.operatorToken.kind !==
                ts.SyntaxKind.BarBarToken ||
            !ts.isIdentifier(alphaBlending.left) ||
            alphaBlending.left.text !== "transparent" ||
            !ts.isIdentifier(alphaBlending.right) ||
            alphaBlending.right.text !== "hasOpacity"
        ) {
            this.context.contractError(
                alphaBlending,
                "Expected opacity state to control alpha blending.",
            );
        }
        const backFaceCulling =
            this.context.propertyInitializer(
                shaderOptions,
                "backFaceCulling",
            );
        if (
            !ts.isIdentifier(backFaceCulling) ||
            backFaceCulling.text !== "backFaceCulling"
        ) {
            this.context.contractError(
                backFaceCulling,
                "Expected GridMaterial culling passthrough.",
            );
        }
        return {
            modulePath,
            symbolName: "createGridMaterial",
            header: "",
            source: `// ${this.context.provenance(
                modulePath,
                "createGridMaterial",
            )}
#include <bblite/runtime.hpp>

#include <cmath>

namespace bbl {

MaterialHandle create_grid_material(
    Engine& engine,
    GridMaterialOptions options) {
    MaterialRecord material;
    material.grid_material = true;
    material.grid_main_color = options.main_color;
    material.grid_line_color = options.line_color;
    material.grid_control = Vec4{
        options.grid_ratio,
        std::round(options.major_unit_frequency),
        options.minor_unit_visibility,
        options.opacity,
    };
    material.grid_offset = options.grid_offset;
    material.grid_visibility = options.visibility;
    material.grid_antialias = options.antialias;
    material.grid_pre_multiply_alpha =
        options.pre_multiply_alpha;
    material.grid_use_max_line = options.use_max_line;
    material.alpha_mode =
        options.opacity < 1.0f
            ? MaterialAlphaMode::blend
            : MaterialAlphaMode::opaque;
    material.double_sided = !options.back_face_culling;
    engine.materials.push_back(material);
    return MaterialHandle{
        static_cast<std::uint32_t>(engine.materials.size() - 1)};
}

} // namespace bbl
`,
        };
    }

    public lowerStandardMaterialFactory(): LoweredSource {
        const modulePath = "src/material/standard/create-standard-material.ts";
        const symbolName = "createStandardMaterial";
        const { file, declaration } = this.context.functionDeclaration(modulePath, symbolName);
        const returnStatement = declaration.body!.statements.find(
            (statement): statement is ts.ReturnStatement =>
                ts.isReturnStatement(statement) && statement.expression !== undefined,
        );
        if (!returnStatement?.expression) throw new Error("Upstream standard material return was not found.");
        let object = returnStatement.expression;
        while (ts.isAsExpression(object) || ts.isParenthesizedExpression(object)) object = object.expression;
        if (!ts.isObjectLiteralExpression(object)) throw new Error("Upstream standard material defaults changed.");
        const tuple = (name: string): string =>
            this.context.cppColor3(
                this.context.numericTuple(this.context.propertyInitializer(object, name), file),
            );
        const scalar = (name: string): string =>
            this.context.floatLiteral(
                this.context.numericValue(
                    this.context.propertyInitializer(object, name),
                    file,
                ),
            );
        return {
            modulePath,
            symbolName,
            header: "",
            source: `// ${this.context.provenance(modulePath, symbolName)}
#include <bblite/runtime.hpp>

namespace bbl {

MaterialHandle create_standard_material(Engine& engine) {
    MaterialRecord material;
    material.standard_material = true;
    material.diffuse_color = ${tuple("diffuseColor")};
    material.base_color_factor.a = ${scalar("alpha")};
    material.specular_color = ${tuple("specularColor")};
    material.specular_power = ${scalar("specularPower")};
    material.emissive_factor = ${tuple("emissiveColor")};
    material.ambient_color = ${tuple("ambientColor")};
    engine.materials.push_back(material);
    return MaterialHandle{static_cast<std::uint32_t>(engine.materials.size() - 1)};
}

} // namespace bbl
`,
        };
    }

    public lowerNoColorMaterialViews(): LoweredSource {
        const standardModule = "src/material/standard/no-color-view.ts";
        const pbrModule = "src/material/pbr/no-color-view.ts";
        const viewModule = "src/material/material-view.ts";
        const dirtyModule = "src/material/material-dirty.ts";
        for (const [modulePath, functionName, flag] of [
            [
                standardModule,
                "createStandardNoColorMaterialView",
                "NO_COLOR_OUTPUT",
            ],
            [
                pbrModule,
                "createPbrNoColorMaterialView",
                "PBR2_NO_COLOR_OUTPUT",
            ],
        ] as const) {
            const { declaration } =
                this.context.functionDeclaration(
                    modulePath,
                    functionName,
                );
            if (
                !this.context.hasNode(
                    declaration,
                    (node) =>
                        ts.isBinaryExpression(node) &&
                        node.operatorToken.kind ===
                            ts.SyntaxKind.BarToken &&
                        ts.isIdentifier(node.right) &&
                        node.right.text === flag,
                )
            ) {
                this.context.contractError(
                    declaration,
                    `Expected no-color feature flag '${flag}'.`,
                );
            }
        }
        const { declaration: createMaterialView } =
            this.context.functionDeclaration(
                viewModule,
                "createMaterialView",
            );
        if (
            !this.context.hasNode(
                createMaterialView,
                (node) =>
                    ts.isCallExpression(node) &&
                    ts.isPropertyAccessExpression(
                        node.expression,
                    ) &&
                    ts.isIdentifier(
                        node.expression.expression,
                    ) &&
                    node.expression.expression.text === "Object" &&
                    node.expression.name.text === "create" &&
                    node.arguments.length >= 1 &&
                    ts.isIdentifier(node.arguments[0]!) &&
                    node.arguments[0].text === "src",
            )
        ) {
            this.context.contractError(
                createMaterialView,
                "Expected material views to inherit from their source.",
            );
        }
        const { declaration: markMaterialUboDirty } =
            this.context.functionDeclaration(
                dirtyModule,
                "markMaterialUboDirty",
            );
        if (
            !this.context.hasNode(
                markMaterialUboDirty,
                (node) =>
                    ts.isPostfixUnaryExpression(node) &&
                    node.operator ===
                        ts.SyntaxKind.PlusPlusToken &&
                    ts.isPropertyAccessExpression(node.operand) &&
                    ts.isIdentifier(
                        node.operand.expression,
                    ) &&
                    node.operand.expression.text === "source" &&
                    node.operand.name.text === "_uboVersion",
            )
        ) {
            this.context.contractError(
                markMaterialUboDirty,
                "Expected source UBO version invalidation.",
            );
        }
        return {
            modulePath: viewModule,
            symbolName:
                "createStandardNoColorMaterialView,createPbrNoColorMaterialView,markMaterialUboDirty",
            header: "",
            source: `// ${this.context.provenance(
                viewModule,
                "createMaterialView",
                `${standardModule}#createStandardNoColorMaterialView, ${pbrModule}#createPbrNoColorMaterialView, and ${dirtyModule}#markMaterialUboDirty`,
            )}
#include <bblite/runtime.hpp>

#include <stdexcept>

namespace bbl {
namespace {

MaterialHandle create_no_color_material_view(
    Engine& engine,
    MaterialHandle source,
    bool standard) {
    if (source.value >= engine.materials.size()) {
        throw std::runtime_error("Invalid source material handle.");
    }
    const MaterialRecord& source_record = engine.materials[source.value];
    if (source_record.standard_material != standard) {
        throw std::runtime_error(
            "No-color material view family does not match its source.");
    }
    MaterialRecord view = source_record;
    view.no_color = true;
    engine.materials.push_back(std::move(view));
    return MaterialHandle{
        static_cast<std::uint32_t>(engine.materials.size() - 1)};
}

} // namespace

MaterialHandle create_standard_no_color_material_view(
    Engine& engine,
    MaterialHandle source) {
    return create_no_color_material_view(engine, source, true);
}

MaterialHandle create_pbr_no_color_material_view(
    Engine& engine,
    MaterialHandle source) {
    return create_no_color_material_view(engine, source, false);
}

void mark_material_ubo_dirty(
    Engine& engine,
    MaterialHandle material) {
    if (material.value >= engine.materials.size()) {
        throw std::runtime_error("Invalid material handle.");
    }
}

} // namespace bbl
`,
        };
    }
}
