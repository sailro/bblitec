import ts from "typescript";
import {
    addressModeByPin,
    textureFilterByPin,
} from "../pinned-address-modes.js";
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
        const { file: groundFile, declaration: ground } =
            this.context.functionDeclaration(
                groundModule,
                "createFlatGroundData",
            );
        const { file: planeFile, declaration: plane } =
            this.context.functionDeclaration(
                planeModule,
                "createPlaneData",
            );
        const { file: sphereFile, declaration: sphere } =
            this.context.functionDeclaration(
                sphereModule,
                "createSphereData",
            );
        const morphModule =
            "src/morph/create-morph-targets.ts";
        const morphFile =
            this.context.sourceFile(morphModule);
        const { declaration: morphTargets } =
            this.context.functionDeclaration(
                morphModule,
                "createMorphTargets",
            );
        this.context.functionDeclaration(
            morphModule,
            "setMorphTargetWeights",
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
        const constructorArrayElements = (
            root: ts.Node,
            variableName: string,
            constructorName: string,
        ): {
            expression: ts.Expression;
            elements: readonly ts.Expression[];
        } => {
            const expression =
                this.context.variableInitializer(
                    root,
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
                elements: unwrapped.arguments[0].elements,
            };
        };
        const numericConstructorArray = (
            file: ts.SourceFile,
            variableName: string,
            constructorName: string,
        ): {
            expression: ts.Expression;
            values: number[];
        } => {
            const { expression, elements } =
                constructorArrayElements(
                    file,
                    variableName,
                    constructorName,
                );
            return {
                expression,
                values: elements.map((element) =>
                    this.context.numericValue(element, file),
                ),
            };
        };

        assertVariable(
            morphFile,
            "MORPH_WEIGHTS_HEADER_BYTES",
            "16",
            "Morph weights header bytes",
        );
        assertVariable(
            morphFile,
            "MORPH_FLOATS_PER_VERTEX",
            "6",
            "Morph floats per vertex",
        );
        assertVariable(
            morphTargets,
            "targetCount",
            "targets.length",
            "Morph target count",
        );

        // The box tables FLOW from the pin instead of being compared against
        // re-typed copies. The emitted add_face helper is structurally a
        // quad (four explicit corners and a vertices.size() - 4 base), so
        // the tables are asserted to still factor into four-corner faces;
        // everything else — corner signs, per-face normals, the shared UV
        // quad, and the two-triangle local index pattern — is decoded from
        // the pinned constants and interpolated into the emission.
        const boxSigns = this.context.unwrapExpression(
            this.context.variableInitializer(
                boxFile,
                "BOX_POSITION_SIGNS",
            ),
        );
        if (!ts.isArrayLiteralExpression(boxSigns)) {
            this.context.contractError(
                boxSigns,
                "Expected BOX_POSITION_SIGNS to be an array literal.",
            );
        }
        const boxSignWords = boxSigns.elements.map((element) =>
            this.context.numericValue(element, boxFile),
        );
        const boxNormals = numericConstructorArray(
            boxFile,
            "BOX_NORMALS",
            "F32",
        );
        const boxUvs = numericConstructorArray(
            boxFile,
            "BOX_UVS",
            "F32",
        );
        const boxIndices = numericConstructorArray(
            boxFile,
            "BOX_INDICES",
            "U32",
        );
        const boxQuadSize = 4;
        const boxFaceCount =
            boxNormals.values.length / (boxQuadSize * 3);
        if (
            !Number.isInteger(boxFaceCount) ||
            boxFaceCount === 0 ||
            boxUvs.values.length !==
                boxFaceCount * boxQuadSize * 2 ||
            boxIndices.values.length % boxFaceCount !== 0 ||
            boxSignWords.length * 32 <
                boxFaceCount * boxQuadSize * 3
        ) {
            this.context.contractError(
                boxNormals.expression,
                "Box tables no longer factor into four-corner faces.",
            );
        }
        // Corner positions, decoded with the same bit order the pinned
        // builder uses — asserted below so a re-packed table cannot be
        // read with a stale decode: bit (face*4+corner)*3+axis, where a
        // set bit is the +half extent of that axis dimension.
        const boxHalfNames = [
            "half_width",
            "half_height",
            "half_depth",
        ] as const;
        const boxFaceCorners = Array.from(
            { length: boxFaceCount },
            (_, face) =>
                Array.from({ length: boxQuadSize }, (_, corner) => {
                    const parts = boxHalfNames.map((name, axis) => {
                        const index =
                            (face * boxQuadSize + corner) * 3 +
                            axis;
                        const sign =
                            (boxSignWords[index >> 5]! >>>
                                (index & 31)) &
                            1;
                        return `${sign === 1 ? "" : "-"}${name}`;
                    });
                    return `Vec3{${parts.join(", ")}}`;
                }),
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(box, "sign"),
            "(BOX_POSITION_SIGNS[index >> 5] >>> (index & 31)) & 1",
            "Box sign decode",
        );
        const boxPositionStores = indexedAssignments(
            box,
            "positions",
        );
        if (boxPositionStores.length !== 1) {
            this.context.contractError(
                box,
                "Expected one box position expansion.",
            );
        }
        // Pins that a set sign bit means +0.5 of the axis dimension, the
        // polarity the decoded corners above rely on.
        this.context.assertExpressionShape(
            boxPositionStores[0]!.right,
            "(sign - 0.5) * dimensions[index % 3]",
            "Box position expansion",
        );
        // Per-face constants: the emitted add_face takes one normal for its
        // four corners and one UV quad shared by every face, so the tables
        // must still collapse that way.
        const boxFaceNormals = Array.from(
            { length: boxFaceCount },
            (_, face) => {
                const base = face * boxQuadSize * 3;
                const normal = boxNormals.values.slice(
                    base,
                    base + 3,
                );
                for (
                    let corner = 1;
                    corner < boxQuadSize;
                    corner += 1
                ) {
                    for (let axis = 0; axis < 3; axis += 1) {
                        if (
                            boxNormals.values[
                                base + corner * 3 + axis
                            ] !== normal[axis]
                        ) {
                            this.context.contractError(
                                boxNormals.expression,
                                "Box face normals are no longer uniform per face.",
                            );
                        }
                    }
                }
                return `Vec3{${normal
                    .map((value) =>
                        this.context.floatLiteral(value),
                    )
                    .join(", ")}}`;
            },
        );
        const boxUvQuad = boxUvs.values.slice(
            0,
            boxQuadSize * 2,
        );
        boxUvs.values.forEach((value, index) => {
            if (value !== boxUvQuad[index % (boxQuadSize * 2)]) {
                this.context.contractError(
                    boxUvs.expression,
                    "Box UV quad is no longer shared by every face.",
                );
            }
        });
        const boxIndicesPerFace =
            boxIndices.values.length / boxFaceCount;
        const boxQuadPattern = boxIndices.values.slice(
            0,
            boxIndicesPerFace,
        );
        boxIndices.values.forEach((value, position) => {
            const face = Math.floor(
                position / boxIndicesPerFace,
            );
            const local = value - face * boxQuadSize;
            if (
                local !==
                    boxQuadPattern[
                        position % boxIndicesPerFace
                    ] ||
                local < 0 ||
                local >= boxQuadSize
            ) {
                this.context.contractError(
                    boxIndices.expression,
                    "Box faces no longer share one local index pattern.",
                );
            }
        });
        // The pinned totals must agree with the factored tables the
        // emission is built from.
        const boxReturn = this.context.returnObject(box);
        for (const [name, expected] of [
            ["vertexCount", boxFaceCount * boxQuadSize],
            ["indexCount", boxIndices.values.length],
        ] as const) {
            if (
                this.context.numericValue(
                    this.context.propertyInitializer(
                        boxReturn,
                        name,
                    ),
                    boxFile,
                ) !== expected
            ) {
                this.context.contractError(
                    boxReturn,
                    `Box '${name}' no longer matches its tables.`,
                );
            }
        }
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
            // Paired with the emitted columns = subdivisions + 1 and the
            // square row loop.
            ["cols", "subdivisions + 1"],
            ["rows", "cols"],
        ] as const) {
            assertVariable(
                ground,
                name,
                expected,
                `Ground '${name}'`,
            );
        }
        // The ground vertex, paired with the emitted ModelVertex: the
        // column/row positions (the emission precomputes width * 0.5f for
        // the exact -width / 2), the constant up normal (which flows), and
        // the UV generation whose tiling scale the emission folds into the
        // generated coordinate — exact, because scaling by the default 1 is
        // an identity in float.
        assertVariable(
            ground,
            "x",
            "-width / 2 + (col / subdivisions) * width",
            "Ground column position",
        );
        assertVariable(
            ground,
            "z",
            "-height / 2 + (1 - row / subdivisions) * height",
            "Ground row position",
        );
        const groundNormalStores = indexedAssignments(
            ground,
            "normals",
        );
        if (groundNormalStores.length !== 3) {
            this.context.contractError(
                ground,
                "Expected three ground normal components.",
            );
        }
        const groundNormal = `Vec3{${groundNormalStores
            .map((assignment) =>
                this.context.floatLiteral(
                    this.context.numericValue(
                        assignment.right,
                        groundFile,
                    ),
                ),
            )
            .join(", ")}}`;
        const groundUvStores = indexedAssignments(
            ground,
            "uvs",
        );
        const expectedGroundUvs = [
            "col / subdivisions",
            "1 - row / subdivisions",
            "uvs[i] * uScale",
            "uvs[i + 1] * vScale",
        ];
        if (
            groundUvStores.length !== expectedGroundUvs.length
        ) {
            this.context.contractError(
                ground,
                "Unexpected ground UV stores.",
            );
        }
        groundUvStores.forEach((assignment, index) =>
            this.context.assertExpressionShape(
                assignment.right,
                expectedGroundUvs[index]!,
                `Ground UV term ${index}`,
            ),
        );
        // The quad corners the pinned winding names, asserted so the
        // emitted snake_case locals keep computing the same offsets, and
        // the winding itself, which FLOWS into the emitted index insert in
        // the pin's own order.
        for (const [name, expected] of [
            ["topLeft", "row * cols + col"],
            ["topRight", "topLeft + 1"],
            ["bottomLeft", "(row + 1) * cols + col"],
            ["bottomRight", "bottomLeft + 1"],
        ] as const) {
            assertVariable(
                ground,
                name,
                expected,
                `Ground corner '${name}'`,
            );
        }
        const groundCornerNames: Record<string, string> = {
            topLeft: "top_left",
            topRight: "top_right",
            bottomLeft: "bottom_left",
            bottomRight: "bottom_right",
        };
        const groundWinding = indexedAssignments(
            ground,
            "indices",
        ).map((assignment) => {
            const right = this.context.unwrapExpression(
                assignment.right,
            );
            const mapped = ts.isIdentifier(right)
                ? groundCornerNames[right.text]
                : undefined;
            if (!mapped) {
                this.context.contractError(
                    assignment,
                    "Expected the ground winding to name a quad corner.",
                );
            }
            return mapped;
        });
        if (groundWinding.length !== 6) {
            this.context.contractError(
                ground,
                "Unexpected ground index count.",
            );
        }

        for (const [name, expected] of [
            ["size", "options.size ?? 1"],
            ["width", "options.width ?? size"],
            ["height", "options.height ?? size"],
            // Paired with the emitted half_width/half_height, which multiply
            // by 0.5f — exact for the pinned divide by two.
            ["hw", "width / 2"],
            ["hh", "height / 2"],
        ] as const) {
            assertVariable(
                plane,
                name,
                expected,
                `Plane '${name}'`,
            );
        }
        // The plane tables FLOW from the pin: each position corner is read
        // as a signed half-extent (or zero) term, the constant normal and
        // the UV corners are read numerically, and the two-triangle index
        // list is read verbatim. Re-typing them as expected shapes is what
        // this replaces.
        const planeHalfNames: Record<string, string> = {
            hw: "half_width",
            hh: "half_height",
        };
        const planeToken = (element: ts.Expression): string => {
            const unwrapped =
                this.context.unwrapExpression(element);
            if (
                ts.isPrefixUnaryExpression(unwrapped) &&
                unwrapped.operator === ts.SyntaxKind.MinusToken &&
                ts.isIdentifier(unwrapped.operand)
            ) {
                const mapped =
                    planeHalfNames[unwrapped.operand.text];
                if (!mapped) {
                    this.context.contractError(
                        unwrapped,
                        "Unexpected plane corner term.",
                    );
                }
                return `-${mapped}`;
            }
            if (ts.isIdentifier(unwrapped)) {
                const mapped = planeHalfNames[unwrapped.text];
                if (!mapped) {
                    this.context.contractError(
                        unwrapped,
                        "Unexpected plane corner term.",
                    );
                }
                return mapped;
            }
            return this.context.floatLiteral(
                this.context.numericValue(unwrapped, planeFile),
            );
        };
        const planePositions = constructorArrayElements(
            plane,
            "positions",
            "F32",
        ).elements.map(planeToken);
        const planeNormals = constructorArrayElements(
            plane,
            "normals",
            "F32",
        ).elements.map(planeToken);
        const planeUvs = constructorArrayElements(
            plane,
            "uvs",
            "F32",
        ).elements.map(planeToken);
        const planeIndicesTable = constructorArrayElements(
            plane,
            "indices",
            "U32",
        );
        const planeIndices = planeIndicesTable.elements.map(
            (element) =>
                this.context.numericValue(element, planeFile),
        );
        const planeVertexCount = planePositions.length / 3;
        if (
            planeVertexCount !== 4 ||
            planeNormals.length !== planeVertexCount * 3 ||
            planeUvs.length !== planeVertexCount * 2 ||
            planeIndices.some(
                (value) =>
                    !Number.isInteger(value) ||
                    value < 0 ||
                    value >= planeVertexCount,
            )
        ) {
            this.context.contractError(
                planeIndicesTable.expression,
                "Plane tables no longer describe an indexed quad.",
            );
        }
        // The emitted quad carries one constant normal on all corners.
        const planeNormalHead = planeNormals.slice(0, 3);
        planeNormals.forEach((value, index) => {
            if (value !== planeNormalHead[index % 3]) {
                this.context.contractError(
                    plane,
                    "Plane normals are no longer uniform.",
                );
            }
        });
        const planeVertices = Array.from(
            { length: planeVertexCount },
            (_, vertex) =>
                `        ModelVertex{
            Vec3{${planePositions
                .slice(vertex * 3, vertex * 3 + 3)
                .join(", ")}},
            Vec3{${planeNormalHead.join(", ")}},
            Vec4{1.0f, 0.0f, 0.0f, 1.0f},
            Vec2{${planeUvs
                .slice(vertex * 2, vertex * 2 + 2)
                .join(", ")}}},`,
        ).join("\n");

        for (const [name, expected] of [
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
        // The sphere tessellation arithmetic, each constant FLOWING into
        // the emitted build_sphere_geometry rather than being re-typed
        // there: the minimum segment clamp, the polar-step base
        // (z_steps = <base> + segments), the azimuthal doubling, and the
        // full-turn factor on the Y angle. The `?? 32` segment default
        // stays an assert: the compiler applies it at the call site, so no
        // literal in this emission carries it.
        const sphereSegments = this.context.unwrapExpression(
            this.context.variableInitializer(
                sphere,
                "segments",
            ),
        );
        if (
            !ts.isCallExpression(sphereSegments) ||
            this.context
                .propertyPath(sphereSegments.expression)
                ?.join(".") !== "Math.max" ||
            sphereSegments.arguments.length !== 2
        ) {
            this.context.contractError(
                sphereSegments,
                "Expected the sphere segment clamp.",
            );
        }
        const sphereMinSegments = this.context.numericValue(
            sphereSegments.arguments[0]!,
            sphereFile,
        );
        this.context.assertExpressionShape(
            sphereSegments.arguments[1]!,
            "options.segments ?? 32",
            "Sphere segment default",
        );
        const spherePolarSteps = this.context.unwrapExpression(
            this.context.variableInitializer(
                sphere,
                "totalZRotationSteps",
            ),
        );
        if (
            !ts.isBinaryExpression(spherePolarSteps) ||
            spherePolarSteps.operatorToken.kind !==
                ts.SyntaxKind.PlusToken ||
            !ts.isIdentifier(spherePolarSteps.right) ||
            spherePolarSteps.right.text !== "segments"
        ) {
            this.context.contractError(
                spherePolarSteps,
                "Expected the polar step count to add a base to the segments.",
            );
        }
        const spherePolarBase = this.context.numericValue(
            spherePolarSteps.left,
            sphereFile,
        );
        const sphereAzimuthSteps =
            this.context.unwrapExpression(
                this.context.variableInitializer(
                    sphere,
                    "totalYRotationSteps",
                ),
            );
        if (
            !ts.isBinaryExpression(sphereAzimuthSteps) ||
            sphereAzimuthSteps.operatorToken.kind !==
                ts.SyntaxKind.AsteriskToken ||
            !ts.isIdentifier(sphereAzimuthSteps.right) ||
            sphereAzimuthSteps.right.text !==
                "totalZRotationSteps"
        ) {
            this.context.contractError(
                sphereAzimuthSteps,
                "Expected the azimuthal step count to scale the polar count.",
            );
        }
        const sphereAzimuthFactor = this.context.numericValue(
            sphereAzimuthSteps.left,
            sphereFile,
        );
        // The reserve sizes, paired with the emitted reserve calls; the
        // indices-per-quad factor is destructured so it can both FLOW into
        // the emitted reserve and be checked against the quad pattern
        // extracted below.
        assertVariable(
            sphere,
            "totalVertices",
            "(totalZRotationSteps + 1) * (totalYRotationSteps + 1)",
            "Sphere vertex total",
        );
        const sphereIndexTotal = this.context.unwrapExpression(
            this.context.variableInitializer(
                sphere,
                "totalIndices",
            ),
        );
        if (
            !ts.isBinaryExpression(sphereIndexTotal) ||
            sphereIndexTotal.operatorToken.kind !==
                ts.SyntaxKind.AsteriskToken ||
            !ts.isNumericLiteral(sphereIndexTotal.right)
        ) {
            this.context.contractError(
                sphereIndexTotal,
                "Expected the sphere index total to scale by a quad factor.",
            );
        }
        this.context.assertExpressionShape(
            sphereIndexTotal.left,
            "totalZRotationSteps * totalYRotationSteps",
            "Sphere quad count",
        );
        const sphereIndicesPerQuad = this.context.numericValue(
            sphereIndexTotal.right,
            sphereFile,
        );
        // The angles, paired with the emitted angle_z/angle_y (the turn
        // factor flows), and the normal components, paired with the
        // emitted Vec3 normal.
        assertVariable(
            sphere,
            "angleZ",
            "normalizedZ * Math.PI",
            "Sphere polar angle",
        );
        const sphereAzimuthAngle =
            this.context.unwrapExpression(
                this.context.variableInitializer(
                    sphere,
                    "angleY",
                ),
            );
        if (
            !ts.isBinaryExpression(sphereAzimuthAngle) ||
            sphereAzimuthAngle.operatorToken.kind !==
                ts.SyntaxKind.AsteriskToken ||
            !ts.isNumericLiteral(sphereAzimuthAngle.right)
        ) {
            this.context.contractError(
                sphereAzimuthAngle,
                "Expected the azimuthal angle to scale by a turn factor.",
            );
        }
        this.context.assertExpressionShape(
            sphereAzimuthAngle.left,
            "normalizedY * Math.PI",
            "Sphere azimuthal angle base",
        );
        const sphereTurnFactor = this.context.numericValue(
            sphereAzimuthAngle.right,
            sphereFile,
        );
        for (const [name, expected] of [
            ["nx", "Math.sin(angleZ) * Math.cos(angleY)"],
            ["ny", "Math.cos(angleZ)"],
            ["nz", "-Math.sin(angleZ) * Math.sin(angleY)"],
        ] as const) {
            assertVariable(
                sphere,
                name,
                expected,
                `Sphere normal '${name}'`,
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
        // The UV order, paired with the emitted Vec2{normalized_y,
        // normalized_z} — the direction is the pin's, not a choice.
        const sphereUvStores = indexedAssignments(
            sphere,
            "uvs",
        );
        const expectedSphereUvs = ["normalizedY", "normalizedZ"];
        if (
            sphereUvStores.length !== expectedSphereUvs.length
        ) {
            this.context.contractError(
                sphere,
                "Unexpected sphere UV stores.",
            );
        }
        sphereUvStores.forEach((assignment, index) =>
            this.context.assertExpressionShape(
                assignment.right,
                expectedSphereUvs[index]!,
                `Sphere UV component ${index}`,
            ),
        );
        // The quad corners and the six-entry triangulation, which FLOWS
        // into the emitted index insert from the pinned store order.
        assertVariable(
            sphere,
            "a",
            "zStep * (totalYRotationSteps + 1) + yStep",
            "Sphere quad base",
        );
        assertVariable(
            sphere,
            "b",
            "a + totalYRotationSteps + 1",
            "Sphere quad step",
        );
        const sphereQuadPattern = indexedAssignments(
            sphere,
            "indices",
        ).map((assignment) => {
            const right = this.context.unwrapExpression(
                assignment.right,
            );
            if (
                ts.isIdentifier(right) &&
                (right.text === "a" || right.text === "b")
            ) {
                return right.text;
            }
            if (
                ts.isBinaryExpression(right) &&
                right.operatorToken.kind ===
                    ts.SyntaxKind.PlusToken &&
                ts.isIdentifier(right.left) &&
                (right.left.text === "a" ||
                    right.left.text === "b") &&
                ts.isNumericLiteral(right.right)
            ) {
                return `${right.left.text} + ${this.context.numericValue(right.right, sphereFile)}`;
            }
            return this.context.contractError(
                assignment,
                "Expected the sphere triangulation to offset the quad corners.",
            );
        });
        if (
            sphereQuadPattern.length !== sphereIndicesPerQuad
        ) {
            this.context.contractError(
                sphereIndexTotal,
                "Sphere quad factor no longer matches its triangulation.",
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
        // The torus radii, grid stride, and parameterization, paired with
        // the emitted create_torus lines (the emission multiplies by 0.5f
        // where the pin divides by two — exact — and inlines px as
        // dx * minor_radius with the same operation order).
        for (const [name, expected] of [
            ["R", "diameter / 2"],
            ["r", "thickness / 2"],
            ["stride", "tessellation + 1"],
            ["vertexCount", "stride * stride"],
            ["px", "dx * r"],
            ["x", "(px + R) * cosOuter"],
            ["y", "dy * r"],
            ["z", "-(px + R) * sinOuter"],
            ["nextI", "(i + 1) % stride"],
            ["nextJ", "(j + 1) % stride"],
        ] as const) {
            assertVariable(
                torus,
                name,
                expected,
                `Torus '${name}'`,
            );
        }
        // The angles: the full-turn factor comes from the pinned TWO_PI and
        // FLOWS into both emitted angle products, and the outer phase
        // divisor flows as the reciprocal the emission multiplies by.
        const torusTwoPi = this.context.unwrapExpression(
            this.context.variableInitializer(torus, "TWO_PI"),
        );
        if (
            !ts.isBinaryExpression(torusTwoPi) ||
            torusTwoPi.operatorToken.kind !==
                ts.SyntaxKind.AsteriskToken ||
            this.context
                .propertyPath(torusTwoPi.left)
                ?.join(".") !== "Math.PI" ||
            !ts.isNumericLiteral(torusTwoPi.right)
        ) {
            this.context.contractError(
                torusTwoPi,
                "Expected TWO_PI to scale Math.PI.",
            );
        }
        const torusTurnFactor = this.context.numericValue(
            torusTwoPi.right,
            torusFile,
        );
        const torusOuterAngle = this.context.unwrapExpression(
            this.context.variableInitializer(
                torus,
                "outerAngle",
            ),
        );
        if (
            !ts.isBinaryExpression(torusOuterAngle) ||
            torusOuterAngle.operatorToken.kind !==
                ts.SyntaxKind.MinusToken
        ) {
            this.context.contractError(
                torusOuterAngle,
                "Expected the torus outer angle to subtract a phase.",
            );
        }
        this.context.assertExpressionShape(
            torusOuterAngle.left,
            "(i * TWO_PI) / tessellation",
            "Torus outer angle sweep",
        );
        const torusOuterPhase = this.context.unwrapExpression(
            torusOuterAngle.right,
        );
        if (
            !ts.isBinaryExpression(torusOuterPhase) ||
            torusOuterPhase.operatorToken.kind !==
                ts.SyntaxKind.SlashToken ||
            this.context
                .propertyPath(torusOuterPhase.left)
                ?.join(".") !== "Math.PI"
        ) {
            this.context.contractError(
                torusOuterPhase,
                "Expected the torus outer phase to divide Math.PI.",
            );
        }
        const torusPhaseDivisor = this.context.numericValue(
            torusOuterPhase.right,
            torusFile,
        );
        const torusInnerAngle = this.context.unwrapExpression(
            this.context.variableInitializer(
                torus,
                "innerAngle",
            ),
        );
        if (
            !ts.isBinaryExpression(torusInnerAngle) ||
            torusInnerAngle.operatorToken.kind !==
                ts.SyntaxKind.PlusToken ||
            this.context
                .propertyPath(torusInnerAngle.right)
                ?.join(".") !== "Math.PI"
        ) {
            this.context.contractError(
                torusInnerAngle,
                "Expected the torus inner angle to add the half-turn phase.",
            );
        }
        this.context.assertExpressionShape(
            torusInnerAngle.left,
            "(j * TWO_PI) / tessellation",
            "Torus inner angle sweep",
        );
        // The stores, paired with the emitted ModelVertex: position and
        // normal component order, and the UV pair whose V complement flows.
        const torusPositionStores = indexedAssignments(
            torus,
            "positions",
        );
        const expectedTorusPositions = ["x", "y", "z"];
        if (
            torusPositionStores.length !==
            expectedTorusPositions.length
        ) {
            this.context.contractError(
                torus,
                "Unexpected torus position stores.",
            );
        }
        torusPositionStores.forEach((assignment, index) =>
            this.context.assertExpressionShape(
                assignment.right,
                expectedTorusPositions[index]!,
                `Torus position component ${index}`,
            ),
        );
        const torusNormalStores = indexedAssignments(
            torus,
            "normals",
        );
        const expectedTorusNormals = [
            "dx * cosOuter",
            "dy",
            "-dx * sinOuter",
        ];
        if (
            torusNormalStores.length !==
            expectedTorusNormals.length
        ) {
            this.context.contractError(
                torus,
                "Unexpected torus normal stores.",
            );
        }
        torusNormalStores.forEach((assignment, index) =>
            this.context.assertExpressionShape(
                assignment.right,
                expectedTorusNormals[index]!,
                `Torus normal component ${index}`,
            ),
        );
        const torusUvStores = indexedAssignments(torus, "uvs");
        if (torusUvStores.length !== 2) {
            this.context.contractError(
                torus,
                "Unexpected torus UV stores.",
            );
        }
        this.context.assertExpressionShape(
            torusUvStores[0]!.right,
            "i / tessellation",
            "Torus UV u",
        );
        const torusUvV = this.context.unwrapExpression(
            torusUvStores[1]!.right,
        );
        if (
            !ts.isBinaryExpression(torusUvV) ||
            torusUvV.operatorToken.kind !==
                ts.SyntaxKind.MinusToken ||
            !ts.isNumericLiteral(torusUvV.left)
        ) {
            this.context.contractError(
                torusUvV,
                "Expected the torus V coordinate to complement a unit.",
            );
        }
        const torusUvUnit = this.context.numericValue(
            torusUvV.left,
            torusFile,
        );
        this.context.assertExpressionShape(
            torusUvV.right,
            "j / tessellation",
            "Torus UV v sweep",
        );
        // The triangulation FLOWS from the pinned store order: each entry
        // is destructured as <corner> * stride + <corner> and re-emitted
        // with the snake_case corner names.
        const torusCornerNames: Record<string, string> = {
            i: "outer_index",
            j: "inner_index",
            nextI: "next_outer",
            nextJ: "next_inner",
        };
        const torusCorner = (
            expression: ts.Expression,
        ): string => {
            const unwrapped =
                this.context.unwrapExpression(expression);
            const mapped = ts.isIdentifier(unwrapped)
                ? torusCornerNames[unwrapped.text]
                : undefined;
            if (!mapped) {
                this.context.contractError(
                    expression,
                    "Expected a torus grid corner.",
                );
            }
            return mapped;
        };
        const torusTriangulation = indexedAssignments(
            torus,
            "indices",
        ).map((assignment) => {
            const right = this.context.unwrapExpression(
                assignment.right,
            );
            if (
                !ts.isBinaryExpression(right) ||
                right.operatorToken.kind !==
                    ts.SyntaxKind.PlusToken
            ) {
                this.context.contractError(
                    assignment,
                    "Expected a torus index of the form corner * stride + corner.",
                );
            }
            const scaled = this.context.unwrapExpression(
                right.left,
            );
            if (
                !ts.isBinaryExpression(scaled) ||
                scaled.operatorToken.kind !==
                    ts.SyntaxKind.AsteriskToken ||
                !ts.isIdentifier(scaled.right) ||
                scaled.right.text !== "stride"
            ) {
                this.context.contractError(
                    assignment,
                    "Expected a torus index of the form corner * stride + corner.",
                );
            }
            return `${torusCorner(scaled.left)} * stride + ${torusCorner(right.right)}`;
        });
        // The reserve factor, checked against the pinned indexCount and
        // FLOWING into the emitted reserve.
        const torusIndexTotal = this.context.unwrapExpression(
            this.context.variableInitializer(
                torus,
                "indexCount",
            ),
        );
        if (
            !ts.isBinaryExpression(torusIndexTotal) ||
            torusIndexTotal.operatorToken.kind !==
                ts.SyntaxKind.AsteriskToken ||
            !ts.isNumericLiteral(torusIndexTotal.right)
        ) {
            this.context.contractError(
                torusIndexTotal,
                "Expected the torus index total to scale by a quad factor.",
            );
        }
        this.context.assertExpressionShape(
            torusIndexTotal.left,
            "stride * stride",
            "Torus quad count",
        );
        if (
            torusTriangulation.length !==
            this.context.numericValue(
                torusIndexTotal.right,
                torusFile,
            )
        ) {
            this.context.contractError(
                torusIndexTotal,
                "Torus quad factor no longer matches its triangulation.",
            );
        }
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
        this.context.functionDeclaration(
            "src/mesh/thin-instance.ts",
            "setThinInstanceCount",
        );
        this.context.functionDeclaration(
            "src/mesh/thin-instance.ts",
            "flushThinInstances",
        );
        const value = (input: number): string => this.context.floatLiteral(input);
        // The emitted fragments the decoded tables above compose. Each is
        // plain text interpolation: the byte-for-byte C++ is unchanged as
        // long as the pin is, and moves with the pin when it moves.
        const boxFaceVertexLines = ["a", "b", "c", "d"]
            .map(
                (name, corner) =>
                    `                ModelVertex{${name}, normal, Vec4{1.0f, 0.0f, 0.0f, 1.0f}, Vec2{${value(
                        boxUvQuad[corner * 2]!,
                    )}, ${value(boxUvQuad[corner * 2 + 1]!)}}},`,
            )
            .join("\n");
        const boxQuadIndexList = boxQuadPattern
            .map((local) =>
                local === 0 ? "start" : `start + ${local}`,
            )
            .join(", ");
        const boxAddFaceCalls = boxFaceCorners
            .map(
                (corners, face) =>
                    `    add_face(\n${corners
                        .map((corner) => `        ${corner},`)
                        .join("\n")}\n        ${boxFaceNormals[face]});`,
            )
            .join("\n");
        const groundWindingList = groundWinding
            .map((corner) => `                    ${corner},`)
            .join("\n");
        const torusTriangulationList = torusTriangulation
            .map((term) => `                    ${term},`)
            .join("\n");
        return {
            modulePath,
            symbolName: "createBox,createGround,createPlane,createSphere,createSphereData,createMorphTargets,setMorphTargetWeights,createTorus,createMeshFromData",
            header: "",
            source: `// ${this.context.provenance(
                modulePath,
                "createBox, createGround, createPlane, createSphere, createSphereData, createMorphTargets, setMorphTargetWeights, createTorus, createMeshFromData",
                "src/mesh/create-box.ts, src/mesh/create-ground.ts, src/mesh/create-plane.ts, src/mesh/create-sphere.ts, src/morph/create-morph-targets.ts, src/mesh/create-torus.ts defaults, and src/math/compute-aabb.ts bounds folding",
            )}
#include <bblite/runtime.hpp>

#include <algorithm>
#include <cmath>
#include <limits>
#include <stdexcept>
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
${boxFaceVertexLines}
            });
        const std::uint32_t start =
            static_cast<std::uint32_t>(geometry.vertices.size() - ${boxQuadSize});
        geometry.indices.insert(
            geometry.indices.end(),
            {${boxQuadIndexList}});
    };
${boxAddFaceCalls}
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
                ${groundNormal},
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
${groundWindingList}
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
${planeVertices}
    };
    geometry.indices = {${planeIndices.join(", ")}};
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

static ModelGeometry build_sphere_geometry(SphereOptions options) {
    const std::uint32_t segments =
        std::max<std::uint32_t>(${sphereMinSegments}, options.segments);
    const Vec3 radius{
        options.diameter_x * 0.5f,
        options.diameter_y * 0.5f,
        options.diameter_z * 0.5f,
    };
    const std::uint32_t z_steps = ${spherePolarBase} + segments;
    const std::uint32_t y_steps = ${sphereAzimuthFactor} * z_steps;
    ModelGeometry geometry;
    geometry.vertices.reserve(
        static_cast<std::size_t>(z_steps + 1) * (y_steps + 1));
    geometry.indices.reserve(
        static_cast<std::size_t>(z_steps) * y_steps * ${sphereIndicesPerQuad});
    for (std::uint32_t z_step = 0; z_step <= z_steps; ++z_step) {
        const float normalized_z =
            static_cast<float>(z_step) / static_cast<float>(z_steps);
        const float angle_z = normalized_z * pi;
        for (std::uint32_t y_step = 0; y_step <= y_steps; ++y_step) {
            const float normalized_y =
                static_cast<float>(y_step) / static_cast<float>(y_steps);
            const float angle_y = normalized_y * pi * ${value(sphereTurnFactor)};
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
                {${sphereQuadPattern.join(", ")}});
        }
    }
    geometry.bounds_min =
        Vec3{-radius.x, -radius.y, -radius.z};
    geometry.bounds_max =
        Vec3{radius.x, radius.y, radius.z};
    for (ModelVertex& vertex : geometry.vertices) {
        vertex.local_position = vertex.position;
    }
    return geometry;
}

SphereMeshData create_sphere_data(SphereOptions options) {
    const ModelGeometry geometry =
        build_sphere_geometry(options);
    SphereMeshData result;
    result.positions.reserve(
        geometry.vertices.size() * 3);
    result.normals.reserve(
        geometry.vertices.size() * 3);
    result.uvs.reserve(
        geometry.vertices.size() * 2);
    for (const ModelVertex& vertex : geometry.vertices) {
        result.positions.insert(
            result.positions.end(),
            {
                vertex.position.x,
                vertex.position.y,
                vertex.position.z,
            });
        result.normals.insert(
            result.normals.end(),
            {
                vertex.normal.x,
                vertex.normal.y,
                vertex.normal.z,
            });
        result.uvs.insert(
            result.uvs.end(),
            {vertex.uv.x, vertex.uv.y});
    }
    result.indices = geometry.indices;
    result.vertex_count = static_cast<std::uint32_t>(
        geometry.vertices.size());
    result.index_count = static_cast<std::uint32_t>(
        geometry.indices.size());
    return result;
}

MeshHandle create_sphere(Engine& engine, SphereOptions options) {
    ModelGeometry geometry =
        build_sphere_geometry(options);
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

void attach_morph_target(
    Engine& engine,
    MeshHandle mesh,
    const std::vector<float>& positions,
    const std::vector<float>& normals,
    double vertex_count,
    float weight) {
    if (
        mesh.value >= engine.meshes.size() ||
        !std::isfinite(vertex_count) ||
        vertex_count < 0.0 ||
        std::floor(vertex_count) != vertex_count) {
        throw std::runtime_error(
            "Invalid direct morph target mesh or vertex count.");
    }
    MeshRecord& record = engine.meshes[mesh.value];
    if (
        record.geometry == invalid_handle ||
        record.geometry >= engine.geometries.size()) {
        throw std::runtime_error(
            "Direct morph targets require mesh geometry.");
    }
    ModelGeometry& geometry =
        engine.geometries[record.geometry];
    const std::size_t count =
        static_cast<std::size_t>(vertex_count);
    if (
        count != geometry.vertices.size() ||
        positions.size() != count * 3 ||
        (!normals.empty() &&
         normals.size() != count * 3)) {
        throw std::runtime_error(
            "Direct morph target data does not match the mesh vertex count.");
    }
    std::vector<Vec3> position_deltas(
        count,
        Vec3{});
    std::vector<Vec3> normal_deltas(
        count,
        Vec3{});
    for (
        std::size_t index = 0;
        index < count;
        ++index) {
        // The shared GPU upload mirrors glTF source-space deltas on X.
        // Primitive data is already in native space, so store the inverse
        // mirror here and let that one upload contract restore the source
        // delta for both paths.
        position_deltas[index] = Vec3{
            -positions[index * 3],
            positions[index * 3 + 1],
            positions[index * 3 + 2],
        };
        if (!normals.empty()) {
            normal_deltas[index] = Vec3{
                -normals[index * 3],
                normals[index * 3 + 1],
                normals[index * 3 + 2],
            };
        }
    }
    geometry.morph_positions.clear();
    geometry.morph_positions.push_back(
        std::move(position_deltas));
    geometry.morph_normals.clear();
    geometry.morph_normals.push_back(
        std::move(normal_deltas));
    geometry.morph_tangents.assign(
        1,
        std::vector<Vec3>(count, Vec3{}));
    record.gpu_deformation = true;
    record.morph_weights = {};
    record.morph_weights[0] = weight;
    record.morph_storage_weights = {weight};
    ++record.morph_weights_version;
    ++record.transform_version;
}

void set_morph_target_weights(
    Engine& engine,
    MeshHandle mesh,
    const std::vector<float>& weights) {
    if (mesh.value >= engine.meshes.size()) {
        throw std::runtime_error(
            "Invalid direct morph target mesh.");
    }
    MeshRecord& record = engine.meshes[mesh.value];
    if (!record.gpu_deformation) {
        throw std::runtime_error(
            "Morph target weights require an attached morph target.");
    }
    const float weight =
        weights.empty() ? 0.0f : weights[0];
    record.morph_weights = {};
    record.morph_weights[0] = weight;
    record.morph_storage_weights = {weight};
    ++record.morph_weights_version;
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
        static_cast<std::size_t>(stride) * stride * ${torusTriangulation.length});
    for (std::uint32_t outer_index = 0;
         outer_index <= tessellation;
         ++outer_index) {
        const float outer_angle =
            static_cast<float>(outer_index) * ${value(torusTurnFactor)} * pi /
                static_cast<float>(tessellation) -
            pi * ${value(1 / torusPhaseDivisor)};
        const float cos_outer = std::cos(outer_angle);
        const float sin_outer = std::sin(outer_angle);
        for (std::uint32_t inner_index = 0;
             inner_index <= tessellation;
             ++inner_index) {
            const float inner_angle =
                static_cast<float>(inner_index) * ${value(torusTurnFactor)} * pi /
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
                    ${value(torusUvUnit)} -
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
${torusTriangulationList}
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

namespace {

// Copy [0, count) instances from the bound caller array into the record's
// pool mirror, matching the pinned dirty range [_dirtyMin=0, _dirtyMax=count).
void copy_thin_instance_range(
    MeshRecord& record,
    const std::vector<float>& matrices,
    std::size_t count) {
    const std::size_t available = std::min(
        count,
        matrices.size() / 16);
    for (std::size_t index = 0; index < available; ++index) {
        std::copy_n(
            matrices.data() + index * 16,
            16,
            record.instance_matrices[index].data());
    }
}

} // namespace

// src/mesh/thin-instance.ts setThinInstances: adopt the caller's matrix
// array with count as both the active count and the allocated capacity
// (_capacity = count). The record keeps aliasing the array so the pinned
// per-frame helpers below can re-read it; the version field mirrors
// _version and gates the PAL re-upload.
void set_thin_instances(
    Engine& engine,
    MeshHandle mesh,
    std::vector<float>& matrices,
    double count) {
    MeshRecord& record = engine.meshes[mesh.value];
    const std::size_t capacity = std::min(
        static_cast<std::size_t>(count),
        matrices.size() / 16);
    record.instance_matrices.assign(
        capacity,
        std::array<float, 16>{});
    copy_thin_instance_range(record, matrices, capacity);
    record.thin_instanced = true;
    record.instance_count =
        static_cast<std::uint32_t>(capacity);
    record.instance_source = &matrices;
    record.instance_version += 1;
}

// src/mesh/thin-instance.ts setThinInstanceCount: update only the active
// instance count and re-upload the [0, count) matrix range from the SAME
// array bound by setThinInstances, leaving the capacity (and therefore
// the allocated GPU buffer) untouched. The pinned helper is a no-op on a
// mesh without thin instances; growing past the established capacity
// would recreate the GPU buffer upstream and is not reached, so it fails
// explicitly here.
void set_thin_instance_count(
    Engine& engine,
    MeshHandle mesh,
    double count) {
    MeshRecord& record = engine.meshes[mesh.value];
    if (!record.thin_instanced ||
        record.instance_source == nullptr) {
        return;
    }
    const std::size_t requested =
        static_cast<std::size_t>(count);
    if (requested > record.instance_matrices.size()) {
        throw std::runtime_error(
            "setThinInstanceCount beyond the established capacity is not reached.");
    }
    copy_thin_instance_range(
        record,
        *record.instance_source,
        requested);
    record.instance_count =
        static_cast<std::uint32_t>(requested);
    record.instance_version += 1;
}

// src/mesh/thin-instance.ts flushThinInstances: mark the whole active
// range dirty after direct array manipulation (_dirtyMin = 0,
// _dirtyMax = count). The pinned helper non-null asserts
// mesh.thinInstances, so a flush without a bound pool fails explicitly.
void flush_thin_instances(Engine& engine, MeshHandle mesh) {
    MeshRecord& record = engine.meshes[mesh.value];
    if (!record.thin_instanced ||
        record.instance_source == nullptr) {
        throw std::runtime_error(
            "flushThinInstances requires thin instances bound by setThinInstances.");
    }
    copy_thin_instance_range(
        record,
        *record.instance_source,
        record.instance_count);
    record.instance_version += 1;
}

} // namespace bbl
`,
        };
    }

    public lowerNodeMaterialFactory(): LoweredSource {
        const modulePath = "src/material/node/node-material.ts";
        const { declaration } = this.context.functionDeclaration(
            modulePath,
            "parseNodeMaterialFromSnippet",
        );
        // The record the pin returns. Everything on it except the family tag
        // and the alpha-blending flag is compiled away — the WGSL, the UBO
        // layout and the bindings are composition's output, and the `inputs`
        // handles that would mutate the block are not lowered — so the two
        // that survive are the two asserted here.
        const material = this.context.objectInitializer(
            declaration,
            "material",
        );
        this.context.assertExpressionShape(
            this.context.propertyInitializer(material, "_needsAlphaBlending"),
            "graph.needsAlphaBlending",
            "NodeMaterial alpha blending",
        );
        this.context.assertExpressionShape(
            this.context.propertyInitializer(material, "_buildGroup"),
            "_buildGroup",
            "NodeMaterial mesh group builder",
        );
        return {
            modulePath,
            symbolName: "parseNodeMaterialFromSnippet",
            header: "",
            source: `// ${
                this.context.provenance(
                    modulePath,
                    "parseNodeMaterialFromSnippet",
                )
            }
#include <bblite/runtime.hpp>
#include <bblite/upstream/node_variants.hpp>

#include <algorithm>
#include <stdexcept>
#include <string>
#include <utility>

namespace bbl {

// The graph was compiled at generation by the pin's own emitter and
// pipeline builder; what remains at run time is which composed program a
// draw uses, and the fixed-function state that program was built with.
MaterialHandle create_node_material(
    Engine& engine,
    std::uint32_t variant,
    std::vector<NodeMaterialTexture> textures) {
    const upstream::NodeVariantEntry& entry =
        upstream::node_variants.at(variant);
    MaterialRecord material;
    material.node_material = true;
    material.shader_variant = variant;
    material.double_sided = !entry.back_face_culling;
    // The graph's declared bindings, in the pin's own allocation order,
    // resolved by name against what the scene supplied -- the join
    // parseNodeMaterialFromSnippet performs when it fills _textureSlots.
    // A binding the record omits is the pin's own render-time error, raised
    // here at material creation instead.
    for (std::size_t index = 0; index < entry.texture_count; ++index) {
        const upstream::NodeVariantTexture& binding =
            upstream::node_variant_textures.at(entry.first_texture + index);
        const auto supplied = std::find_if(
            textures.begin(),
            textures.end(),
            [&](const NodeMaterialTexture& candidate) {
                return candidate.name == binding.name;
            });
        if (supplied == textures.end()) {
            throw std::runtime_error(
                "NodeMaterial: texture binding '" +
                std::string(binding.name) +
                "' not set. Provide it via options.textures.");
        }
        material.shader_textures.push_back(std::move(supplied->texture));
    }
    engine.materials.push_back(std::move(material));
    return MaterialHandle{
        static_cast<std::uint32_t>(engine.materials.size() - 1)};
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
                "createShaderMaterial,setShaderUniform,setShaderFloat,setShaderVector3,setShaderTexture,setAlphaToCoverage",
            header: "",
            source: `// ${this.context.provenance(modulePath, "createShaderMaterial")}
#include <bblite/runtime.hpp>
#include <bblite/upstream/renderer_plan.hpp>

#include <algorithm>
#include <stdexcept>

namespace bbl {

// The generated shader-variant table carries the pinned fixed-function
// mapping (needAlphaBlending -> blend alpha mode, backFaceCulling ->
// double-sided, needAlphaTesting, depthWrite) and the reflected uniform
// layout with the createShaderMaterial defaultValue floats.
MaterialHandle create_shader_material(
    Engine& engine,
    std::uint32_t variant) {
    const upstream::ShaderVariantInfo& info =
        upstream::shader_variant_info(variant);
    MaterialRecord material;
    material.shader_material = true;
    material.shader_variant = variant;
    material.double_sided = !info.back_face_culling;
    material.shader_alpha_testing = info.alpha_testing;
    material.shader_depth_write = info.depth_write;
    if (info.alpha_blending) {
        material.alpha_mode = MaterialAlphaMode::blend;
    }
    material.shader_uniform_values = info.defaults;
    material.shader_uniform_values.resize(info.value_count, 0.0f);
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
    return material;
}

// Offset setter shared by setShaderUniform/setShaderFloat/
// setShaderVector3: the compiler resolves (variant, uniform name) to the
// flat value offset through the reflected layout at compile time.
void set_shader_uniform_values(
    Engine& engine,
    MaterialHandle material,
    std::uint32_t offset,
    std::uint32_t count,
    const float* values) {
    MaterialRecord& record = shader_material(engine, material);
    if (offset + count > record.shader_uniform_values.size()) {
        throw std::runtime_error("Shader uniform write out of range.");
    }
    std::copy_n(
        values,
        count,
        record.shader_uniform_values.begin() + offset);
}

void set_shader_uniform_value(
    Engine& engine,
    MaterialHandle material,
    std::uint32_t offset,
    float v0) {
    const float values[1] = {v0};
    set_shader_uniform_values(engine, material, offset, 1u, values);
}

void set_shader_uniform_value(
    Engine& engine,
    MaterialHandle material,
    std::uint32_t offset,
    float v0,
    float v1) {
    const float values[2] = {v0, v1};
    set_shader_uniform_values(engine, material, offset, 2u, values);
}

void set_shader_uniform_value(
    Engine& engine,
    MaterialHandle material,
    std::uint32_t offset,
    float v0,
    float v1,
    float v2) {
    const float values[3] = {v0, v1, v2};
    set_shader_uniform_values(engine, material, offset, 3u, values);
}

void set_shader_uniform_value(
    Engine& engine,
    MaterialHandle material,
    std::uint32_t offset,
    float v0,
    float v1,
    float v2,
    float v3) {
    const float values[4] = {v0, v1, v2, v3};
    set_shader_uniform_values(engine, material, offset, 4u, values);
}

// setShaderTexture: the pin stores the Texture2D on the slot the sampler
// name owns and bumps _resourceVersion so the group-1 bind group rebuilds.
// The compiler resolved the name to that slot; the version has no native
// counterpart because a reached scene binds before registration, so the
// bind group is built once from what the record holds.
void set_shader_texture(
    Engine& engine,
    MaterialHandle material,
    std::uint32_t slot,
    FileTexture texture) {
    MaterialRecord& record = shader_material(engine, material);
    if (record.shader_textures.size() <= slot) {
        record.shader_textures.resize(slot + 1);
    }
    record.shader_textures[slot] = std::move(texture);
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

    /**
     * `pixels-texture.ts`: a texture the caller hands its own RGBA bytes.
     *
     * The bytes are baked, so what is lowered is the rest of the pin's
     * factory — the two size checks and the sampler it settles when the
     * caller overrides nothing, which is every reached call.
     */
    public lowerPixelsTextureFactory(): LoweredSource {
        const module = "src/texture/pixels-texture.ts";
        const { declaration } =
            this.context.functionDeclaration(
                module,
                "createTexture2DFromPixels",
            );
        // The sampler the pin settles when the caller overrides nothing,
        // which is every reached call. Each field is checked as the pin
        // writes it and then emitted through the shared name-to-enumerator
        // tables, so the default and the enumerator cannot drift apart and a
        // mode with no row fails generation naming it.
        const sampler = this.context.variableInitializer(
            declaration,
            "samplerDesc",
        );
        if (!ts.isObjectLiteralExpression(sampler)) {
            this.context.contractError(
                sampler,
                "Expected the pinned pixels-texture sampler literal.",
            );
        }
        const samplerDefault = (
            name: string,
            fallback: string,
            table: Readonly<Record<string, string>>,
        ): string => {
            this.context.assertExpressionShape(
                this.context.propertyInitializer(sampler, name),
                `options.${name} ?? "${fallback}"`,
                `createTexture2DFromPixels ${name}`,
            );
            const enumerator = table[fallback];
            if (!enumerator) {
                this.context.contractError(
                    sampler,
                    `Pinned createTexture2DFromPixels defaults ${name} to '${fallback}', which has no runtime enumerator.`,
                );
            }
            return enumerator;
        };
        const addressU = samplerDefault(
            "addressModeU",
            "clamp-to-edge",
            addressModeByPin,
        );
        const addressV = samplerDefault(
            "addressModeV",
            "clamp-to-edge",
            addressModeByPin,
        );
        const minFilter = samplerDefault(
            "minFilter",
            "nearest",
            textureFilterByPin,
        );
        const magFilter = samplerDefault(
            "magFilter",
            "nearest",
            textureFilterByPin,
        );
        // The byte count the pin requires, which the baked buffer has to
        // meet for the same reason it does upstream.
        this.context.assertExpressionShape(
            this.context.variableInitializer(
                declaration,
                "expected",
            ),
            "width * height * 4",
            "createTexture2DFromPixels expected byte count",
        );
        return {
            modulePath: module,
            symbolName: "createTexture2DFromPixels",
            header: "",
            source: `// ${this.context.provenance(module, "createTexture2DFromPixels")}
#include <bblite/runtime.hpp>
#include <bblite/pal.hpp>

#include <stdexcept>
#include <string>

namespace bbl {

PixelsTexture create_texture_2d_from_pixels(
    Engine&,
    const std::string& path,
    double width,
    double height) {
    if (width < 1.0 || height < 1.0) {
        throw std::runtime_error(
            "createTexture2DFromPixels: width/height must be >= 1");
    }
    PixelsTexture texture;
    texture.rgba = pal::read_binary_file(path);
    texture.width = static_cast<std::uint32_t>(width);
    texture.height = static_cast<std::uint32_t>(height);
    const std::size_t expected =
        static_cast<std::size_t>(texture.width) *
        static_cast<std::size_t>(texture.height) * 4u;
    if (texture.rgba.size() < expected) {
        throw std::runtime_error(
            "createTexture2DFromPixels: data too short for " +
            std::to_string(texture.width) + "x" +
            std::to_string(texture.height) + " RGBA");
    }
    // The pin's own defaults, read above rather than restated. It creates
    // no mip chain, so mip sampling clamps to the base level.
    texture.sampler.min_filter = ${minFilter};
    texture.sampler.mag_filter = ${magFilter};
    texture.sampler.mipmap_mode = TextureMipmapMode::nearest;
    texture.sampler.address_u = ${addressU};
    texture.sampler.address_v = ${addressV};
    texture.sampler.max_anisotropy = 1.0f;
    texture.sampler.max_lod = 0.0f;
    return texture;
}

} // namespace bbl
`,
        };
    }

    /**
     * The two scene-code Texture2D sources, in a translation unit of their
     * own.
     *
     * They live in the pin's own `src/texture/` rather than in any material
     * module, and a scene can reach them without reaching PBR at all -- a
     * custom shader material binding a loaded image is the case. Bundling
     * them into the PBR factory made `loadTexture2D` an undefined symbol
     * for such a scene, which is upstream's boundary expressed wrongly
     * here; `texture_pixels.cpp` already carries the third source this way.
     */
    public lowerFileTextureFactory(): LoweredSource {
        const solidModule = "src/texture/solid-texture.ts";
        const textureModule = "src/texture/texture-2d.ts";
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
        this.context.functionDeclaration(textureModule, "loadTexture2D");
        // `loadTexture2D` is the memoizing wrapper; the upload and the
        // sampler it builds live in the impl it defers to.
        const loadTexture = this.context.functionDeclaration(
            textureModule,
            "loadTexture2DImpl",
        ).declaration;
        // The sampler's anisotropy is the one pinned default that is a rule
        // rather than a constant: the intrinsic restates it beside the other
        // defaults, so the shape it restates is asserted here. A pin that
        // changes either arm, or the condition it forks on, refuses
        // generation instead of shading through a different filter.
        const anisotropy = this.context.findNodes(
            loadTexture,
            (node): node is ts.PropertyAssignment =>
                ts.isPropertyAssignment(node) &&
                this.context.propertyName(node.name) === "maxAnisotropy",
        )[0];
        if (!anisotropy) {
            this.context.contractError(
                loadTexture,
                "Pinned loadTexture2DImpl no longer sets maxAnisotropy.",
            );
        }
        this.context.assertExpressionShape(
            anisotropy.initializer,
            "allLinear ? 4 : 1",
            "loadTexture2D sampler anisotropy",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(loadTexture, "allLinear"),
            'minF === "linear" && magF === "linear" && mipF === "linear"',
            "loadTexture2D all-linear test",
        );
        return {
            modulePath: textureModule,
            symbolName: "loadTexture2D,createSolidTexture2D",
            header: "",
            source: `// ${this.context.provenance(
                textureModule,
                "loadTexture2D",
                `${solidModule}#createSolidTexture2D`,
            )}
#include <bblite/runtime.hpp>
#include <bblite/pal.hpp>

#include <algorithm>
#include <cmath>

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

SolidTexture create_solid_texture(
    Engine&,
    float r,
    float g,
    float b,
    float a) {
    // The pin's own rounding, performed once. The texel is what reaches the
    // GPU; the float view is that same byte over 255, because a slot that
    // bakes the texture into a fallback and a slot that uploads it must not
    // disagree about the value.
    const auto quantize = [](float value) {
        return static_cast<std::uint8_t>(
            std::lround(std::clamp(value, 0.0f, 1.0f) * 255.0f));
    };
    SolidTexture texture;
    texture.texel = {quantize(r), quantize(g), quantize(b), quantize(a)};
    texture.color = Color4{
        static_cast<float>(texture.texel[0]) / 255.0f,
        static_cast<float>(texture.texel[1]) / 255.0f,
        static_cast<float>(texture.texel[2]) / 255.0f,
        static_cast<float>(texture.texel[3]) / 255.0f,
    };
    return texture;
}

} // namespace bbl
`,
        };
    }

    public lowerPbrMaterialFactory(): LoweredSource {
        const pbrModule = "src/material/pbr/pbr-material.ts";
        // The opt-in setters replaced the unlit/skyboxMode options. Each is
        // one stamp plus an unconditional extension registration, and the
        // stamped field name is what `composeScenePbrVariants` hands the
        // pinned composer: a renamed one would compose a fragment missing
        // that arm rather than failing, so every stamp is pinned by shape.
        // The `isEnabled` guards stay where the pin keeps them, in the UBO
        // writers.
        for (const [module, symbol, stamp] of [
            ["set-unlit.ts", "setPbrUnlit", "mat._unlit = true"],
            ["set-skybox.ts", "setPbrSkybox", "mat._skyboxMode = true"],
            ["set-emissive.ts", "setPbrEmissive", "mat._emissiveColor = color"],
            ["set-sheen.ts", "setPbrSheen", "mat._sheen = sheen"],
            [
                "set-clearcoat.ts",
                "setPbrClearCoat",
                "mat._clearCoat = clearCoat",
            ],
            [
                "set-iridescence.ts",
                "setPbrIridescence",
                "mat._iridescence = iridescence",
            ],
        ] as const) {
            const { declaration } = this.context.functionDeclaration(
                `src/material/pbr/${module}`,
                symbol,
            );
            // `setPbrUnlit`'s optional tint is a second assignment, so the
            // stamp is located by its own left-hand path rather than by
            // being the only one.
            const target = stamp.slice(0, stamp.indexOf(" "));
            const stamps = this.context
                .findNodes(
                    declaration,
                    (node): node is ts.BinaryExpression =>
                        ts.isBinaryExpression(node) &&
                        node.operatorToken.kind ===
                            ts.SyntaxKind.EqualsToken,
                )
                .filter(
                    (node) =>
                        this.context
                            .propertyPath(node.left)
                            ?.join(".") === target,
                );
            if (stamps.length !== 1) {
                this.context.contractError(
                    declaration,
                    `Expected ${symbol} to stamp ${stamp}.`,
                );
            }
            this.context.assertExpressionShape(stamps[0]!, stamp, symbol);
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
        return {
            modulePath: pbrModule,
            symbolName: "createPbrMaterial,setPbrUnlit,setPbrSkybox,setPbrEmissive,setPbrIridescence",
            header: "",
            source: `// ${this.context.provenance(pbrModule, "createPbrMaterial")}
#include <bblite/runtime.hpp>

#include <algorithm>
#include <cmath>
#include <utility>

namespace bbl {

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

// src/material/pbr/set-unlit.ts and set-skybox.ts: the optional PBR
// features are opt-in setters that flag an existing material and
// register their fragment extension.
void set_pbr_unlit(Engine& engine, MaterialHandle material) {
    engine.materials[material.value].unlit = true;
}

void set_pbr_emissive(
    Engine& engine,
    MaterialHandle material,
    Color3 color) {
    engine.materials[material.value].emissive_factor = color;
}

void set_pbr_skybox(Engine& engine, MaterialHandle material) {
    engine.materials[material.value].skybox_mode = true;
}

// src/material/pbr/fragments/clearcoat-fragment.ts#writeClearcoatUBO leaves
// the whole clearcoat slice at zero unless isEnabled is set, so a disabled
// coat keeps the record's zero intensity and shades as no coat at all.
// The pinned defaults live in the same writer: intensity 1, roughness 0,
// index of refraction 1.5, normal scale 1.
// src/material/pbr/fragments/sheen-fragment.ts#writeSheenUBO: a disabled
// sheen writes no slice, and the record's zero sheen color shades as none.
// The pinned defaults are colour [1,1,1], roughness 0, intensity 1.
void set_pbr_sheen(
    Engine& engine,
    MaterialHandle material,
    bool enabled,
    Color3 color,
    float roughness,
    float intensity) {
    if (!enabled) {
        return;
    }
    MaterialRecord& record = engine.materials[material.value];
    record.sheen_color = color;
    record.sheen_roughness = roughness;
    record.sheen_intensity = intensity;
}

// The sheen tint texture modulates the colour. It is applied whether or not
// the layer is enabled, matching the pin, where the props object carries the
// texture and the UBO writer is what consults isEnabled.
void set_pbr_sheen_texture(
    Engine& engine,
    MaterialHandle material,
    FileTexture texture) {
    engine.materials[material.value].sheen_color_texture =
        std::move(texture.data);
}

void set_pbr_clearcoat(
    Engine& engine,
    MaterialHandle material,
    bool enabled,
    float intensity,
    float roughness,
    float index_of_refraction,
    float normal_scale) {
    if (!enabled) {
        return;
    }
    MaterialRecord& record = engine.materials[material.value];
    record.clearcoat_intensity = intensity;
    record.clearcoat_roughness = roughness;
    record.clearcoat_index_of_refraction = index_of_refraction;
    record.clearcoat_normal_scale = normal_scale;
}

// src/material/pbr/fragments/iridescence-fragment.ts#writeIridescenceUBO:
// a disabled layer writes no slice, and the record's zero intensity shades
// as none. The pinned defaults are in the same writer -- intensity 1, index
// of refraction 1.3, thickness 100..400 nm -- and the compiler resolved
// them at the call site, so the values arrive already defaulted.
void set_pbr_iridescence(
    Engine& engine,
    MaterialHandle material,
    bool enabled,
    float intensity,
    float index_of_refraction,
    float minimum_thickness,
    float maximum_thickness) {
    if (!enabled) {
        return;
    }
    MaterialRecord& record = engine.materials[material.value];
    record.iridescence_intensity = intensity;
    record.iridescence_index_of_refraction = index_of_refraction;
    record.iridescence_minimum_thickness = minimum_thickness;
    record.iridescence_maximum_thickness = maximum_thickness;
}

MaterialHandle create_pbr_material(
    Engine& engine,
    PbrMaterialOptions options) {
    MaterialRecord material;
    // The pin's createPbrMaterial is {...props}: a solid texture IS the
    // texture -- createSolidTexture2D writes the rounded texel into a 1x1
    // rgba8unorm sampled without decode -- and the factors stay the options'
    // values. The texels ride the slots' fallback bytes; folding them into
    // the factors would double-apply against the composed fragment, which
    // samples the slot and declares no factor field for them.
    material.base_color_fallback = options.base_color.texel;
    material.base_color_fallback_srgb = false;
    material.orm_fallback = options.orm.texel;
    material.base_color_factor = {1.0f, 1.0f, 1.0f, 1.0f};
    material.roughness_factor = options.roughness_factor;
    material.metallic_factor = options.metallic_factor;
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

    /**
     * The two Standard texture slots a frame-graph attachment can fill.
     *
     * They are one lowering because they are one shape: store the
     * reference, raise the flag. Each is gated on the feature named after
     * it, so a scene reaching neither compiles neither -- which is what
     * kept them apart before, in the Standard factory and the no-colour
     * view TU, neither of which is named for them.
     */
    public lowerStandardTextureSetters(
        diffuse: boolean,
        emissive: boolean,
    ): LoweredSource {
        const rttModule = "src/texture/rtt.ts";
        return {
            modulePath: rttModule,
            symbolName: [
                ...(diffuse ? ["material.diffuseTexture"] : []),
                ...(emissive ? ["setStandardEmissiveTexture"] : []),
            ].join(","),
            header: "",
            source: `// ${this.context.provenance(
                rttModule,
                "createRenderTargetTexture",
                "src/material/standard/standard-material.ts#diffuseTexture and src/material/standard/set-std-emissive.ts#setStandardEmissiveTexture",
            )}
#include <bblite/runtime.hpp>

#include <stdexcept>

namespace bbl {

namespace {

MaterialRecord& render_texture_material(
    Engine& engine,
    MaterialHandle material) {
    if (material.value >= engine.materials.size()) {
        throw std::runtime_error("Invalid material handle.");
    }
    return engine.materials[material.value];
}

} // namespace
${diffuse ? `
// The plain material.diffuseTexture write, for the one source the reached
// slice gives it: a colour render target.
//
// rtt.ts hands that attachment back as a Texture2D carrying invertY: true,
// and isStandardUvInverted reads exactly that property off the diffuse
// texture, so the material's UV block flips V. A loaded image carries no
// such property -- loadTexture2D flips at upload instead -- which is why
// the record's uv_invert_y and invert_y are separate fields.
void set_standard_diffuse_render_texture(
    Engine& engine,
    MaterialHandle material,
    RenderTextureRef texture) {
    MaterialRecord& record = render_texture_material(engine, material);
    record.diffuse_render_texture = texture;
    record.has_diffuse_render_texture = true;
    record.base_color_texture.uv_invert_y = true;
}
` : ""}${emissive ? `
// The pinned setter stores the texture and registers the emissive
// extension; registration is a bundling concern with no native
// counterpart, because generation composes against every Standard
// extension the pin ships.
void set_standard_emissive_texture(
    Engine& engine,
    MaterialHandle material,
    RenderTextureRef texture) {
    MaterialRecord& record = render_texture_material(engine, material);
    record.emissive_render_texture = texture;
    record.has_emissive_render_texture = true;
}
` : ""}
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
