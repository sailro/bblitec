import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { type PinnedBinding } from "./pinned-numeric-lowerer.js";
import { pinnedNumericMathCalls, pinnedRoundCall } from "./pinned-operators.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";

export const physicsHeightfieldModule = "src/physics/havok-heightfield.ts";

/** Grid extraction and Havok buffer order belong to the pinned source. */
export function lowerPhysicsHeightfield(context: LoweringContext): { header: string; source: string } {
    const { file, declaration } = context.functionDeclaration(physicsHeightfieldModule, "optionsFromGroundMesh");

    const body = lowerPinnedBody(file, declaration.body!.statements, {
        bindings: new Map<string, PinnedBinding>([
            ["mesh._cpuPositions", { cpp: "positions", type: "f32" }],
            ["mesh.worldMatrix", { cpp: "world_matrix", type: "f32" }],
            ["Infinity", { cpp: "std::numeric_limits<double>::infinity()", type: "scalar" }],
        ]),
        booleanOr: true,
        calls: new Map([...pinnedNumericMathCalls(), ["Math.round", pinnedRoundCall],
            ["Number.isInteger", args => `(std::isfinite(${args[0]}) && std::trunc(${args[0]}) == ${args[0]})`]]),
        methods: new Map([["fill", (receiver, args) => `std::fill(${receiver}.begin(), ${receiver}.end(), static_cast<float>(${args[0]}))`]]),
        statement: (statement, numeric, indent) => {
            if (ts.isIfStatement(statement) && context.expressionMatchesShape(statement.expression, "!localPositions || localPositions.length === 0")) {
                context.assertStatementShapes(statement, [statement], `if (!localPositions || localPositions.length === 0) { throw new Error("createHeightFieldShape ground mesh has no vertex positions."); }`, "heightfield absent positions");
                const condition = statement.expression as ts.BinaryExpression;
                const buffer = numeric.expression((condition.left as ts.PrefixUnaryExpression).operand);
                return [`${indent}if (${buffer}.empty()) throw std::runtime_error("createHeightFieldShape ground mesh has no vertex positions.");`];
            }
            if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression) &&
                ts.isElementAccessExpression(statement.expression.left) && ts.isIdentifier(statement.expression.left.expression) &&
                statement.expression.left.expression.text === "matrix") {
                const assignment = statement.expression;
                if (assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken) context.contractError(assignment, "Heightfield matrix writes require direct numeric assignment.");
                const slot = assignment.left as ts.ElementAccessExpression;
                return [`${indent}const double matrix_index = ${numeric.expression(slot.argumentExpression)};`,
                    `${indent}if (bbl::js::array_has_index(matrix, matrix_index)) matrix[static_cast<std::size_t>(matrix_index)] = static_cast<float>(${numeric.expression(assignment.right)});`];
            }
            if (ts.isThrowStatement(statement) && ts.isNewExpression(statement.expression) && statement.expression.arguments?.[0] && ts.isTemplateExpression(statement.expression.arguments[0])) {
                const message = statement.expression.arguments[0];
                context.assertExpressionShape(message, "`createHeightFieldShape requires a regular (N+1)×(N+1) grid mesh (e.g. from createGroundFromHeightMap); got ${vertexCount} vertices, which is not the square of an integer ≥ 2.`", "heightfield grid diagnostic");
                return [`${indent}throw std::runtime_error("createHeightFieldShape requires a regular square grid; got " + bbl::js::number_to_string(${numeric.expression(message.templateSpans[0]!.expression)}) + " vertices.");`];
            }
            return undefined;
        },
        returnValue: (expression, lowerer) => {
            if (!expression || !ts.isObjectLiteralExpression(expression)) context.contractError(declaration, "Expected resolved heightfield inputs.");
            context.assertExpressionShape(expression, "{ numX: samples, numZ: samples, sizeX: extendX * 2, sizeZ: extendZ * 2, data: matrix }", "resolved ground heightfield fields");
            return `HeightfieldInputs{${["numX", "numZ", "sizeX", "sizeZ", "data"].map(name => lowerer.expression(context.propertyInitializer(expression, name))).join(", ")}}`;
        },
    });
    const factory = context.functionDeclaration(physicsHeightfieldModule, "createHeightFieldShape").declaration;
    context.assertStatementShapes(factory, factory.body!.statements, `
        const { _hknp: hknp } = world;
        const resolved = options.groundMesh ? optionsFromGroundMesh(options.groundMesh) : resolveExplicit(options);
        const { numX, numZ, sizeX, sizeZ, data } = resolved;
        const totalNumHeights = numX * numZ;
        const bufferBegin = hknp._malloc(totalNumHeights * 4);
        const heightBuffer = new Float32Array(hknp.HEAPU8.buffer, bufferBegin, totalNumHeights);
        for (let x = 0; x < numX; x++) { for (let z = 0; z < numZ; z++) {
            const hkIndex = z * numX + x;
            const bjsIndex = (numX - 1 - x) * numZ + z;
            heightBuffer[hkIndex] = data[bjsIndex]!;
        } }
        const scaleX = sizeX / (numX - 1);
        const scaleZ = sizeZ / (numZ - 1);
        const hkShape = hknp.HP_Shape_CreateHeightField(numX, numZ, [scaleX, 1, scaleZ], bufferBegin)[1];
        hknp._free(bufferBegin);
        return { _hkShape: hkShape, _type: PhysicsShapeType.HEIGHTFIELD };
    `, "heightfield resolution, Float32 conversion, orientation, scales and opaque constructor");

    const remap = lowerPinnedBody(file, factory.body!.statements.slice(6, 9), {
        bindings: new Map<string, PinnedBinding>([
            ...["numX", "numZ", "sizeX", "sizeZ"].map(name => [name, { cpp: `resolved.${name}`, type: "scalar" as const }] as const),
            ["data", { cpp: "resolved.data", type: "f32" }],
            ["heightBuffer", { cpp: "heights", type: "f32", mutable: true }],
        ]), calls: pinnedNumericMathCalls(),
    });
    return {
        header: "PhysicsShape create_physics_heightfield_from_ground(PhysicsWorldHandle world, MeshHandle mesh);\n",
        source: `
namespace {
struct HeightfieldInputs { double numX, numZ, sizeX, sizeZ; std::vector<float> data; };
// ${context.provenance(physicsHeightfieldModule, "optionsFromGroundMesh", "world-space bounds and Float32 square-grid extraction")}
HeightfieldInputs pinned_ground_heightfield(const std::vector<float>& positions, const std::array<float, 16>& world_matrix) {
${body}
}
}
PhysicsShape create_physics_heightfield_from_ground(PhysicsWorldHandle world, MeshHandle mesh) {
    const Engine& engine = *physics_world_record(world).engine;
    const MeshRecord& record = engine.meshes.at(mesh.value);
    std::vector<float> positions;
    if (record.geometry < engine.geometries.size()) {
        const auto& vertices = engine.geometries[record.geometry].vertices;
        positions.reserve(vertices.size() * 3);
        for (const auto& vertex : vertices) {
            const auto& position = record.detached_imported_mesh ? vertex.local_position : vertex.position;
            positions.insert(positions.end(), {position.x, position.y, position.z});
        }
    }
    const auto resolved = pinned_ground_heightfield(positions, mesh_world_matrix(engine, record));
    std::vector<float> heights(static_cast<std::size_t>(resolved.numX * resolved.numZ));
${remap}
    return PhysicsShape{pal::physics_shape_create_heightfield(static_cast<std::uint32_t>(resolved.numX), static_cast<std::uint32_t>(resolved.numZ), {scaleX, 1, scaleZ}, heights)};
}
`,
    };
}
