import ts from "typescript";
import { cppIdentifierPattern } from "../../cpp-literals.js";
import { LoweredSource, LoweringContext } from "../context.js";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
} from "../pinned-numeric-lowerer.js";
import { pinnedNumericMathCalls } from "../pinned-operators.js";
import { lowerObjectComponents } from "../pinned-function-lowerer.js";

/**
 * The mesh-builder half of the factory unit: the pinned CreateBox /
 * CreateGround / CreateSphere / CreateTorus / CreateCylinder family and
 * the geometry plumbing their emitted C++ shares. The material and
 * texture factories extend this class in `material-factories.ts`; the
 * combined surface stays `FactoryLowerer`, re-exported by
 * `factory-lowerer.ts`.
 */
export class MeshBuilderLowerer {
    public constructor(protected readonly context: LoweringContext) {}

    /**
     * @param features - what the scene reached. Every builder below is
     * emitted only where its own feature is in it, the way the rest of this
     * unit's surface follows what the scene touches.
     */
    public lowerMeshFactories(
        features: readonly string[] = [],
    ): LoweredSource {
        // Asked of the feature list rather than taken as one positional
        // boolean per builder: which builders a scene reached is already
        // stated there, and the family only grows.
        const instanceColors = features.includes(
            "mesh:thin-instance-colors",
        );
        const heightMapGround = features.includes("mesh:ground-heightmap");
        const disc = features.includes("mesh:disc");
        const cylinder = features.includes("mesh:cylinder");
        const polyhedron = features.includes("mesh:polyhedron");
        // The tube and the extrude both finish through the ribbon under
        // their own names -- which is how the pin composes them -- so
        // reaching either reaches this unit's ribbon.
        const ribbon =
            features.includes("mesh:ribbon") ||
            features.includes("mesh:extrude") ||
            features.includes("mesh:tube");
        const boxModule = "src/mesh/create-box.ts";
        const groundModule = "src/mesh/create-ground.ts";
        const planeModule = "src/mesh/create-plane.ts";
        const sphereModule = "src/mesh/create-sphere.ts";
        const torusModule = "src/mesh/create-torus.ts";
        const discModule = "src/mesh/create-disc.ts";
        const cylinderModule = "src/mesh/create-cylinder.ts";
        const polyhedronModule = "src/mesh/create-polyhedron.ts";
        const ribbonModule = "src/mesh/create-ribbon.ts";
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
        // The pin's own maths, plus the one helper three builders share:
        // `computeNormals` is emitted once beside them, so a call to it is
        // a call rather than another copy of its body.
        const meshMathCalls = new Map([
            ...pinnedNumericMathCalls(),
            [
                "len",
                (args: readonly string[]): string =>
                    `pinned_ribbon_len(${args.join(", ")})`,
            ],
            [
                "sub",
                (args: readonly string[]): string =>
                    `pinned_ribbon_sub(${args.join(", ")})`,
            ],
            [
                "computeNormals",
                (args: readonly string[]): string =>
                    `pinned_compute_normals(${args.join(", ")})`,
            ],
        ]);
        /**
         * Lower one pinned generator body into the shared native array
         * record. The four arrays and their indexed stores come from the
         * function's own AST; only the option spellings are specialized to
         * the native record that has already applied the same defaults.
         */
        const lowerPinnedMeshBuilder = (
            file: ts.SourceFile,
            declaration: ts.FunctionDeclaration,
            optionBindings: ReadonlyMap<string, string>,
            // A binding whose type is not the scalar every option is: a
            // jagged table the pin indexes, or a flag it branches on.
            optionTypes: ReadonlyMap<
                string,
                PinnedBinding["type"]
            > = new Map(),
            // Whether THIS body's `||` only joins conditions. Most of the
            // family's do; `createRibbonData` also writes the
            // value-selecting `Math.sqrt(...) || 1`, which the C++ operator
            // would flatten to the constant 1 and stop normalizing a seam
            // normal -- the exact rewrite this translator exists to refuse.
            booleanOr = true,
        ): string => {
            if (!declaration.body) {
                this.context.contractError(
                    declaration,
                    "Expected the pinned mesh builder to have a body.",
                );
            }
            const bindings = new Map<string, PinnedBinding>([
                [
                    "Math.PI",
                    { cpp: "pi_double", type: "scalar" },
                ],
                ...Array.from(optionBindings, ([name, cpp]) => [
                    name,
                    {
                        cpp,
                        type: optionTypes.get(name) ?? "scalar",
                    } as PinnedBinding,
                ] as [string, PinnedBinding]),
            ]);
            let lowerer: PinnedNumericLowerer;
            const returnValue = (
                expression: ts.Expression | undefined,
            ): string => {
                if (!expression || !ts.isObjectLiteralExpression(expression)) {
                    return this.context.contractError(
                        declaration,
                        "Expected the pinned mesh builder to return an object literal.",
                    );
                }
                const members = new Map<string, ts.Expression>();
                for (const property of expression.properties) {
                    if (
                        ts.isShorthandPropertyAssignment(property) &&
                        ts.isIdentifier(property.name)
                    ) {
                        members.set(property.name.text, property.name);
                    } else if (
                        ts.isPropertyAssignment(property) &&
                        ts.isIdentifier(property.name)
                    ) {
                        members.set(property.name.text, property.initializer);
                    } else {
                        this.context.contractError(
                            property,
                            "Expected named mesh-data return fields.",
                        );
                    }
                }
                const required = (
                    name: string,
                ): ts.Expression => {
                    const value = members.get(name);
                    if (!value) {
                        return this.context.contractError(
                            expression,
                            `Expected mesh-data return field '${name}'.`,
                        );
                    }
                    return value;
                };
                const arrays = [
                    "positions",
                    "normals",
                    "uvs",
                    "indices",
                ].map((name) => {
                    const value = lowerer.expression(required(name));
                    // A builder that grew a `number[]` returns the
                    // CONVERSION of it, which is already a temporary, and
                    // moving a prvalue is the pessimizing move clang
                    // refuses. One that preallocated returns the buffer by
                    // NAME, which must move -- so a bare identifier is
                    // exactly the case that does.
                    return cppIdentifierPattern.test(value)
                        ? `std::move(${value})`
                        : value;
                });
                const vertexCount = members.has("vertexCount")
                    ? lowerer.expression(required("vertexCount"))
                    : bindings.get("vertexCount")?.cpp;
                const indexCount = members.has("indexCount")
                    ? lowerer.expression(required("indexCount"))
                    : bindings.get("indexCount")?.cpp;
                if (!vertexCount || !indexCount) {
                    return this.context.contractError(
                        expression,
                        "Expected mesh-data vertexCount and indexCount locals.",
                    );
                }
                return (
                    `PinnedMeshData{${arrays.join(", ")}, ` +
                    `static_cast<std::uint32_t>(${vertexCount}), ` +
                    `static_cast<std::uint32_t>(${indexCount})}`
                );
            };
            lowerer = new PinnedNumericLowerer(file, {
                bindings,
                calls: meshMathCalls,
                listCalls: new Set(["computeNormals"]),
                returnValue,
                booleanOr,
                // Every `&&` in the pinned builder family joins a CONDITION
                // -- an `if` test, a `while` test, or a guard ternary's test
                // -- and none of them selects a value. Audited across all
                // ten builders; the five that were already lowered contain
                // none at all, so this is inert for them.
                booleanAnd: true,
                maybeUnusedConst: true,
            });
            return declaration.body.statements
                .flatMap((statement) =>
                    lowerer.statement(statement, "    "),
                )
                .join("\n");
        };
        /**
         * The pin's displacement pass, lowered from its own body.
         *
         * It returns nothing and mutates the record the grid builder above
         * produced, so it binds that record's three arrays rather than
         * producing new ones -- the same translator, a different shape.
         */
        const lowerPinnedHeightmap = (): string => {
            const { file, declaration } =
                this.context.functionDeclaration(
                    groundModule,
                    "applyHeightmap",
                );
            if (!declaration.body) {
                this.context.contractError(
                    declaration,
                    "Expected the pinned heightmap pass to have a body.",
                );
            }
            const bindings = new Map<string, PinnedBinding>([
                ["ground.positions", { cpp: "data.positions", type: "f32" }],
                ["ground.normals", { cpp: "data.normals", type: "f32" }],
                ["ground.indices", { cpp: "data.indices", type: "u32" }],
                ["heightmapData", { cpp: "pixels", type: "u8-view" }],
                ["hmWidth", { cpp: "hm_width", type: "scalar" }],
                ["hmHeight", { cpp: "hm_height", type: "scalar" }],
                ["subdivisions", { cpp: "subdivisions", type: "scalar" }],
                ["minHeight", { cpp: "min_height", type: "scalar" }],
                ["maxHeight", { cpp: "max_height", type: "scalar" }],
            ]);
            const lowerer = new PinnedNumericLowerer(file, {
                bindings,
                calls: meshMathCalls,
                methods: new Map([
                    [
                        "fill",
                        (receiver, args) =>
                            `std::fill(${receiver}.begin(), ` +
                            `${receiver}.end(), ` +
                            `static_cast<float>(${args[0]}))`,
                    ],
                ]),
                // NOT booleanOr: this body's two `|| 1` guards select a
                // VALUE (a zero-length normal falls back to 1), which the
                // C++ operator would flatten to a bool.
                maybeUnusedConst: true,
            });
            return declaration.body.statements
                .flatMap((statement) =>
                    lowerer.statement(statement, "    "),
                )
                .join("\n");
        };
        const heightmapBody = heightMapGround ? lowerPinnedHeightmap() : "";
        const groundBuilderBody = lowerPinnedMeshBuilder(
            groundFile,
            ground,
            new Map([
                ["opts.width", "options.width"],
                ["opts.height", "options.height"],
                ["opts.subdivisions", "options.subdivisions"],
                ["opts.uvScale?.[0]", "options.uv_scale.x"],
                ["opts.uvScale?.[1]", "options.uv_scale.y"],
            ]),
        );
        const sphereBuilderBody = lowerPinnedMeshBuilder(
            sphereFile,
            sphere,
            new Map([
                ["options.segments", "options.segments"],
                ["options.diameter", "options.diameter_x"],
                ["options.diameterX", "options.diameter_x"],
                ["options.diameterY", "options.diameter_y"],
                ["options.diameterZ", "options.diameter_z"],
            ]),
        );
        // The disc, the first builder the pin writes with a GROWN
        // `number[]` rather than a preallocated typed array: it pushes its
        // positions and its indices and converts at the end, which is where
        // its float rounding happens. `vertexCount`/`indexCount` are bound
        // rather than returned, because the pin's own return names neither.
        const discBuilderBody = !disc
            ? ""
            : lowerPinnedMeshBuilder(
                  this.context.sourceFile(discModule),
                  this.context.functionDeclaration(
                      discModule,
                      "createDiscData",
                  ).declaration,
                  new Map([
                      ["options.radius", "options.radius"],
                      ["options.tessellation", "options.tessellation"],
                      ["options.arc", "options.arc"],
                      ["vertexCount", "positions.size() / 3"],
                      ["indexCount", "indices.size()"],
                  ]),
              );
        const discFactory = !disc
            ? ""
            : `static PinnedMeshData pinned_create_disc_data(
    DiscOptions options) {
${discBuilderBody}
}

MeshHandle create_disc(Engine& engine, DiscOptions options) {
    PinnedMeshData data = pinned_create_disc_data(options);
    return create_mesh_from_data(
        engine,
        "${this.context.pinnedFactoryMeshName("createDisc")}",
        data.positions,
        data.normals,
        data.indices,
        data.uvs,
        {},
        {},
        {});
}
`;
        // The cylinder, cone and truncated cone are one pinned builder. Its
        // diameters bind UNCLAMPED, because the body asks two different
        // questions of the same field: the ring maths uses the value after
        // a zero is clamped to 0.00001, and the cone-tip normal reuse asks
        // whether the SCENE wrote a zero. Both reads work off the raw value
        // because the clamp is a local the body writes itself.
        const cylinderBuilderBody = !cylinder
            ? ""
            : lowerPinnedMeshBuilder(
                  this.context.sourceFile(cylinderModule),
                  this.context.functionDeclaration(
                      cylinderModule,
                      "createCylinderData",
                  ).declaration,
                  new Map([
                      ["options.height", "options.height"],
                      ["options.diameterTop", "options.diameter_top"],
                      // The cone-tip arm asks whether the SCENE named a
                      // zero top -- a different question from the clamped
                      // value the rings use, and one the record answers.
                      [
                          "options.diameterTop === 0",
                          "options.diameter_top_is_zero",
                      ],
                      ["options.diameterBottom", "options.diameter_bottom"],
                      ["options.tessellation", "options.tessellation"],
                      ["options.subdivisions", "options.subdivisions"],
                      ["vertexCount", "positions.size() / 3"],
                      ["indexCount", "indices.size()"],
                  ]),
                  new Map([["options.diameterTop === 0", "bool"]]),
              );
        const cylinderFactory = !cylinder
            ? ""
            : `static PinnedMeshData pinned_create_cylinder_data(
    CylinderOptions options) {
${cylinderBuilderBody}
}

MeshHandle create_cylinder(Engine& engine, CylinderOptions options) {
    PinnedMeshData data = pinned_create_cylinder_data(options);
    return create_mesh_from_data(
        engine,
        "${this.context.pinnedFactoryMeshName("createCylinder")}",
        data.positions,
        data.normals,
        data.indices,
        data.uvs,
        {},
        {},
        {});
}
`;
        // `computeNormals`, the accumulation three of the pinned builders
        // hand their grown positions and indices to. Emitted once, from the
        // pin's own body, because the three call it rather than each
        // carrying a copy.
        const normalsModule = "src/mesh/compute-normals.ts";
        const computeNormals = !polyhedron && !ribbon
            ? ""
            : (() => {
                  const { file, declaration } =
                      this.context.functionDeclaration(
                          normalsModule,
                          "computeNormals",
                      );
                  if (!declaration.body) {
                      this.context.contractError(
                          declaration,
                          "Expected computeNormals to have a body.",
                      );
                  }
                  const lowerer = new PinnedNumericLowerer(file, {
                      bindings: new Map<string, PinnedBinding>([
                          ["Math.PI", { cpp: "pi_double", type: "scalar" }],
                          ["positions", { cpp: "positions", type: "f64-list" }],
                          ["indices", { cpp: "indices", type: "f64-list" }],
                      ]),
                      calls: meshMathCalls,
                      returnValue: (expression) =>
                          expression
                              ? lowerer.expression(expression)
                              : this.context.contractError(
                                    declaration,
                                    "Expected computeNormals to return.",
                                ),
                      booleanOr: true,
                      booleanAnd: true,
                      maybeUnusedConst: true,
                  });
                  const body = declaration.body.statements
                      .flatMap((statement) =>
                          lowerer.statement(statement, "    "),
                      )
                      .join("\n");
                  return `// ${this.context.provenance(
                      normalsModule,
                      "computeNormals",
                  )}
static std::vector<double> pinned_compute_normals(
    const std::vector<double>& positions,
    const std::vector<double>& indices) {
${body}
}

`;
              })();
        // The polyhedron. Its type table is pinned DATA and the type a
        // scene names is a compile-time value, so generation picks the row
        // and the record carries that row's own vertex and face lists --
        // which is why `type`, `size` and `data` are bound here rather than
        // recomputed: each is a local the caller already resolved.
        const polyhedronBuilderBody = !polyhedron
            ? ""
            : lowerPinnedMeshBuilder(
                  this.context.sourceFile(polyhedronModule),
                  this.context.functionDeclaration(
                      polyhedronModule,
                      "createPolyhedronData",
                  ).declaration,
                  new Map([
                      ["type", "0"],
                      ["size", "0.0"],
                      ["data", "options"],
                      ["data.vertex", "options.vertex"],
                      ["data.face", "options.face"],
                      ["sizeX", "options.size_x"],
                      ["sizeY", "options.size_y"],
                      ["sizeZ", "options.size_z"],
                      ["flat", "options.flat"],
                      ["vertexCount", "positions.size() / 3"],
                      ["indexCount", "indices.size()"],
                  ]),
                  new Map([
                      ["flat", "bool"],
                      ["data.vertex", "f64-list-2d"],
                      ["data.face", "f64-list-2d"],
                  ]),
              );
        const polyhedronFactory = !polyhedron
            ? ""
            : `static PinnedMeshData pinned_create_polyhedron_data(
    PolyhedronOptions options) {
${polyhedronBuilderBody}
}

MeshHandle create_polyhedron(Engine& engine, PolyhedronOptions options) {
    PinnedMeshData data =
        pinned_create_polyhedron_data(std::move(options));
    return create_mesh_from_data(
        engine,
        "${this.context.pinnedFactoryMeshName("createPolyhedron")}",
        data.positions,
        data.normals,
        data.indices,
        data.uvs,
        {},
        {},
        {});
}
`;
        // `len` and `sub`, the two vector helpers `createRibbonData`
        // declares beside itself. Lowered from their own bodies rather than
        // written here, because a square root and three subtractions are
        // exactly the kind of formula this port must not re-type.
        const ribbonVectorHelpers = !ribbon
            ? ""
            : (() => {
                  const file = this.context.sourceFile(ribbonModule);
                  const lowerHelper = (
                      symbol: string,
                      parameters: readonly string[],
                      signature: string,
                      returns: (
                          expression: ts.Expression,
                          lowerer: PinnedNumericLowerer,
                      ) => string,
                  ): string => {
                      const { declaration } =
                          this.context.functionDeclaration(
                              ribbonModule,
                              symbol,
                          );
                      if (!declaration.body) {
                          this.context.contractError(
                              declaration,
                              `Expected ${symbol} to have a body.`,
                          );
                      }
                      const lowerer: PinnedNumericLowerer =
                          new PinnedNumericLowerer(file, {
                              bindings: new Map<string, PinnedBinding>(
                                  parameters.map((parameter) => [
                                      parameter,
                                      { cpp: parameter, type: "vec3" },
                                  ]),
                              ),
                              calls: meshMathCalls,
                              returnValue: (expression) =>
                                  expression
                                      ? returns(expression, lowerer)
                                      : this.context.contractError(
                                            declaration,
                                            `${symbol} returns nothing.`,
                                        ),
                              booleanOr: true,
                              booleanAnd: true,
                          });
                      const body = declaration.body.statements
                          .flatMap((statement) =>
                              lowerer.statement(statement, "    "),
                          )
                          .join("\n");
                      return `${signature} {\n${body}\n}\n\n`;
                  };
                  return (
                      lowerHelper(
                          "len",
                          ["v"],
                          "static double pinned_ribbon_len(const Vec3d& v)",
                          (expression, lowerer) =>
                              lowerer.expression(expression),
                      ) +
                      lowerHelper(
                          "sub",
                          ["a", "b"],
                          "static Vec3d pinned_ribbon_sub(\n" +
                              "    const Vec3d& a,\n    const Vec3d& b)",
                          // The pin returns a `{x, y, z}` literal, and
                          // the record this port stores is that literal's
                          // three components in the pin's own order.
                          (expression, lowerer) =>
                              `Vec3d{${lowerObjectComponents(
                                  this.context,
                                  lowerer,
                                  expression,
                                  ["x", "y", "z"],
                              ).join(", ")}}`,
                      )
                  );
              })();
        const ribbonBuilderBody = !ribbon
            ? ""
            : lowerPinnedMeshBuilder(
                  this.context.sourceFile(ribbonModule),
                  this.context.functionDeclaration(
                      ribbonModule,
                      "createRibbonData",
                  ).declaration,
                  new Map([
                      // The record is taken by value and dead after this
                      // read, and the pin reads `pathArray` exactly once,
                      // so the rows MOVE rather than being deep-copied.
                      [
                          "options.pathArray",
                          "std::move(options.path_array)",
                      ],
                      // The two flags bind as the LOCALS the pin resolves
                      // them into, so its `options.closeArray || false`
                      // coercion is one generation already made -- which
                      // leaves the body's only other `||` the
                      // value-selecting one, lowered as such.
                      ["closeArray", "options.close_array"],
                      ["closePath", "options.close_path"],
                      // No reached ribbon names an offset, and the pin's
                      // own default for it is not a constant -- it is
                      // `floor(pathArray[0].length / 2)`, which the body
                      // computes one line above. Binding the read to that
                      // local is taking the absent arm exactly.
                      ["options.offset", "defaultOffset"],
                      ["vertexCount", "positions.size() / 3"],
                      ["indexCount", "indices.size()"],
                  ]),
                  new Map([
                      ["options.pathArray", "vec3-list-2d"],
                      ["closeArray", "bool"],
                      ["closePath", "bool"],
                  ]),
                  false,
              );
        const ribbonFactory = !ribbon
            ? ""
            : `${ribbonVectorHelpers}static PinnedMeshData pinned_create_ribbon_data(
    RibbonOptions options) {
${ribbonBuilderBody}
}

/**
 * The ribbon, under whichever pinned factory's name asked for it.
 *
 * \`createExtrudeShape\` finishes through \`createRibbonData\` too, under its
 * own mesh name -- so the triangulation lives here once and the name is the
 * caller's, which is exactly how the pin composes the two.
 */
MeshHandle create_ribbon_mesh(
    Engine& engine,
    RibbonOptions options,
    std::string_view name) {
    PinnedMeshData data = pinned_create_ribbon_data(std::move(options));
    return create_mesh_from_data(
        engine,
        std::string(name),
        data.positions,
        data.normals,
        data.indices,
        data.uvs,
        {},
        {},
        {});
}

MeshHandle create_ribbon(Engine& engine, RibbonOptions options) {
    return create_ribbon_mesh(
        engine,
        std::move(options),
        "${this.context.pinnedFactoryMeshName("createRibbon")}");
}
`;
        const torusBuilderBody = lowerPinnedMeshBuilder(
            torusFile,
            torus,
            new Map([
                ["opts.diameter", "options.diameter"],
                ["opts.thickness", "options.thickness"],
                ["opts.tessellation", "options.tessellation"],
            ]),
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
        // column/row positions (emitted as the pin writes them, in double),
        // the constant up normal (which flows), and the UV generation whose
        // tiling scale the emission applies to the stored float, as the
        // pin's own second pass does.
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
        // These values remain validation-only anchors around the AST-driven
        // bodies. Reading them still makes a reshaped pin fail by name; the
        // emitted arithmetic now comes from PinnedNumericLowerer instead.
        void groundNormal;
        void sphereMinSegments;
        void spherePolarBase;
        void sphereAzimuthFactor;
        void sphereTurnFactor;
        void torusTurnFactor;
        void torusPhaseDivisor;
        void torusUvUnit;
        void torusDiameter;
        void torusThickness;
        void torusTessellation;
        void groundWinding;
        void torusTriangulation;
        const modulePath = "src/mesh/mesh-factories.ts";
        const { declaration: meshFromData } =
            this.context.functionDeclaration(
                modulePath,
                "createMeshFromData",
            );
        // The record's `name` comes second, right after the engine — the
        // compiled intrinsic maps the scene's argument 1 onto it, and the
        // factory literals above are read from the same position.
        const nameParameter = meshFromData.parameters[1];
        if (
            !nameParameter ||
            !ts.isIdentifier(nameParameter.name) ||
            nameParameter.name.text !== "name"
        ) {
            this.context.contractError(
                meshFromData,
                "Expected createMeshFromData to take the mesh name second.",
            );
        }
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
        if (instanceColors) {
            this.context.functionDeclaration(
                "src/mesh/thin-instance.ts",
                "setThinInstanceColors",
            );
        }
        this.context.functionDeclaration(
            "src/mesh/thin-instance.ts",
            "setThinInstanceCount",
        );
        this.context.functionDeclaration(
            "src/mesh/thin-instance.ts",
            "flushThinInstances",
        );
        const instanceColorSetter = instanceColors
            ? `// src/mesh/thin-instance.ts setThinInstanceColors: bind the
// per-instance RGBA stream a material with useThinInstanceColors reads.
// The pinned setter stores the caller's array and bumps its colour
// version; nothing in the reached slice re-reads it (the per-instance
// setThinInstanceColor twin is unlowered), so the record takes a copy.
void set_thin_instance_colors(
    Engine& engine,
    MeshHandle mesh,
    const std::vector<float>& colors) {
    MeshRecord& record = engine.meshes[mesh.value];
    record.instance_colors = colors;
    record.instance_version += 1;
}

`
            : "";
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
        return {
            modulePath,
            symbolName: [
                "createBox,createGround,createPlane,createSphere",
                "createSphereData,createMorphTargets",
                "setMorphTargetWeights,createTorus,createMeshFromData",
                ...(disc ? ["createDisc"] : []),
                ...(cylinder ? ["createCylinder"] : []),
                ...(polyhedron ? ["createPolyhedron"] : []),
                ...(ribbon ? ["createRibbon"] : []),
            ].join(","),
            header: "",
            source: `// ${this.context.provenance(
                modulePath,
                [
                    "createBox, createGround, createPlane, createSphere",
                    "createSphereData, createMorphTargets",
                    "setMorphTargetWeights, createTorus, createMeshFromData",
                    ...(disc ? ["createDisc"] : []),
                    ...(cylinder ? ["createCylinder"] : []),
                    ...(polyhedron ? ["createPolyhedron"] : []),
                    ...(ribbon ? ["createRibbon"] : []),
                ].join(", "),
                [
                    "src/mesh/create-box.ts, src/mesh/create-ground.ts",
                    "src/mesh/create-plane.ts, src/mesh/create-sphere.ts",
                    "src/morph/create-morph-targets.ts",
                    "src/mesh/create-torus.ts",
                    ...(disc ? ["src/mesh/create-disc.ts"] : []),
                    ...(cylinder ? ["src/mesh/create-cylinder.ts"] : []),
                    ...(polyhedron
                        ? ["src/mesh/create-polyhedron.ts"]
                        : []),
                    ...(ribbon
                        ? [
                              "src/mesh/create-ribbon.ts",
                              "src/mesh/compute-normals.ts",
                          ]
                        : []),
                ].join(", ") +
                    " defaults, and src/math/compute-aabb.ts bounds folding",
            )}
${ribbon || heightMapGround ? "#include <bblite/js_data.hpp>\n" : ""}\
#include <bblite/runtime.hpp>
${heightMapGround ? `\
#include <bblite/pal.hpp>
#include <bblite/pal_image.hpp>
` : ""}
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
    mesh.name = "${this.context.pinnedFactoryMeshName("createBox")}";
    mesh.dimensions = Vec3{width, height, depth};
    mesh.geometry =
        static_cast<std::uint32_t>(engine.geometries.size() - 1);
    engine.meshes.push_back(mesh);
    return MeshHandle{static_cast<std::uint32_t>(engine.meshes.size() - 1)};
}

// The common return shape of the three pinned typed-array builders. Their
// bodies below are translated from the pinned AST by PinnedNumericLowerer;
// this record is only the native carrier used to pack those arrays into the
// runtime's interleaved ModelVertex representation.
struct PinnedMeshData {
    std::vector<float> positions;
    std::vector<float> normals;
    std::vector<float> uvs;
    std::vector<std::uint32_t> indices;
    std::uint32_t vertex_count = 0;
    std::uint32_t index_count = 0;
};

static PinnedMeshData pinned_create_flat_ground_data(
    GroundOptions options) {
${groundBuilderBody}
}

MeshHandle create_ground(Engine& engine, GroundOptions options) {
    PinnedMeshData data =
        pinned_create_flat_ground_data(options);
    ModelGeometry geometry;
    geometry.vertices.reserve(data.vertex_count);
    for (std::size_t vertex = 0; vertex < data.vertex_count; ++vertex) {
        geometry.vertices.push_back(ModelVertex{
            Vec3{
                data.positions[vertex * 3],
                data.positions[vertex * 3 + 1],
                data.positions[vertex * 3 + 2],
            },
            Vec3{
                data.normals[vertex * 3],
                data.normals[vertex * 3 + 1],
                data.normals[vertex * 3 + 2],
            },
            Vec4{1.0f, 0.0f, 0.0f, 1.0f},
            Vec2{
                data.uvs[vertex * 2],
                data.uvs[vertex * 2 + 1],
            },
        });
    }
    geometry.indices = std::move(data.indices);
    const float half_width = static_cast<float>(options.width * 0.5);
    const float half_height = static_cast<float>(options.height * 0.5);
    geometry.bounds_min = Vec3{-half_width, 0.0f, -half_height};
    geometry.bounds_max = Vec3{half_width, 0.0f, half_height};
    for (ModelVertex& vertex : geometry.vertices) {
        vertex.local_position = vertex.position;
    }
    engine.geometries.push_back(std::move(geometry));
    MeshRecord mesh;
    mesh.primitive = PrimitiveKind::ground;
    mesh.name = "${this.context.pinnedFactoryMeshName("createGround")}";
    mesh.dimensions = Vec3{
        static_cast<float>(options.width),
        0.0f,
        static_cast<float>(options.height),
    };
    mesh.geometry =
        static_cast<std::uint32_t>(engine.geometries.size() - 1);
    engine.meshes.push_back(mesh);
    return MeshHandle{static_cast<std::uint32_t>(engine.meshes.size() - 1)};
}

${!heightMapGround ? "" : `// The pin's displacement pass, translated from its own body: it reads the
// image's luminance into the grid's Y and then rebuilds the normals. The
// image reaches it as RGBA8 because that is what the pin's own canvas
// readback hands it.
static void pinned_apply_heightmap(
    PinnedMeshData& data,
    const std::vector<std::uint8_t>& pixels,
    double hm_width,
    double hm_height,
    double subdivisions,
    double min_height,
    double max_height) {
${heightmapBody}
}

MeshHandle create_ground_from_height_map(
    Engine& engine,
    GroundOptions options,
    double min_height,
    double max_height,
    const char* height_map) {
    PinnedMeshData data =
        pinned_create_flat_ground_data(options);
    const pal::DecodedImage image = pal::decode_image(
        js::ArrayBuffer(
            pal::read_binary_file(asset_path(height_map))));
    pinned_apply_heightmap(
        data,
        image.rgba,
        static_cast<double>(image.width),
        static_cast<double>(image.height),
        static_cast<double>(options.subdivisions),
        min_height,
        max_height);
    // The pin hands the displaced arrays to the same factory the flat
    // ground uses, so the bounds fold and the mesh name come from there
    // rather than from a second spelling of either.
    return create_mesh_from_data(
        engine,
        "ground",
        data.positions,
        data.normals,
        data.indices,
        data.uvs,
        {},
        {},
        {});
}
`}
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
    mesh.name = "${this.context.pinnedFactoryMeshName("createPlane")}";
    mesh.primitive = PrimitiveKind::gltf;
    mesh.geometry = static_cast<std::uint32_t>(engine.geometries.size() - 1);
    engine.meshes.push_back(mesh);
    return MeshHandle{static_cast<std::uint32_t>(engine.meshes.size() - 1)};
}

static PinnedMeshData pinned_create_sphere_data(
    SphereOptions options) {
${sphereBuilderBody}
}

static ModelGeometry build_sphere_geometry(SphereOptions options) {
    PinnedMeshData data = pinned_create_sphere_data(options);
    ModelGeometry geometry;
    geometry.vertices.reserve(data.vertex_count);
    for (std::size_t vertex = 0; vertex < data.vertex_count; ++vertex) {
        geometry.vertices.push_back(ModelVertex{
            Vec3{
                data.positions[vertex * 3],
                data.positions[vertex * 3 + 1],
                data.positions[vertex * 3 + 2],
            },
            Vec3{
                data.normals[vertex * 3],
                data.normals[vertex * 3 + 1],
                data.normals[vertex * 3 + 2],
            },
            Vec4{1.0f, 0.0f, 0.0f, 1.0f},
            Vec2{
                data.uvs[vertex * 2],
                data.uvs[vertex * 2 + 1],
            },
        });
    }
    geometry.indices = std::move(data.indices);
    const Vec3d radius{
        options.diameter_x * 0.5,
        options.diameter_y * 0.5,
        options.diameter_z * 0.5,
    };
    geometry.bounds_min = Vec3{
        static_cast<float>(-radius.x),
        static_cast<float>(-radius.y),
        static_cast<float>(-radius.z),
    };
    geometry.bounds_max = Vec3{
        static_cast<float>(radius.x),
        static_cast<float>(radius.y),
        static_cast<float>(radius.z),
    };
    for (ModelVertex& vertex : geometry.vertices) {
        vertex.local_position = vertex.position;
    }
    return geometry;
}

SphereMeshData create_sphere_data(SphereOptions options) {
    PinnedMeshData data = pinned_create_sphere_data(options);
    SphereMeshData result;
    result.positions = std::move(data.positions);
    result.normals = std::move(data.normals);
    result.uvs = std::move(data.uvs);
    result.indices = std::move(data.indices);
    result.vertex_count = data.vertex_count;
    result.index_count = data.index_count;
    return result;
}

MeshHandle create_sphere(Engine& engine, SphereOptions options) {
    ModelGeometry geometry =
        build_sphere_geometry(options);
    engine.geometries.push_back(std::move(geometry));
    MeshRecord mesh;
    mesh.primitive = PrimitiveKind::sphere;
    mesh.name = "${this.context.pinnedFactoryMeshName("createSphere")}";
    mesh.dimensions = Vec3{
        static_cast<float>(options.diameter_x),
        static_cast<float>(options.diameter_y),
        static_cast<float>(options.diameter_z),
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

static PinnedMeshData pinned_create_torus_data(
    TorusOptions options) {
${torusBuilderBody}
}

MeshHandle create_torus(Engine& engine, TorusOptions options) {
    PinnedMeshData data = pinned_create_torus_data(options);
    ModelGeometry geometry;
    geometry.vertices.reserve(data.vertex_count);
    for (std::size_t vertex = 0; vertex < data.vertex_count; ++vertex) {
        const Vec3 position{
            data.positions[vertex * 3],
            data.positions[vertex * 3 + 1],
            data.positions[vertex * 3 + 2],
        };
        geometry.vertices.push_back(ModelVertex{
            position,
            Vec3{
                data.normals[vertex * 3],
                data.normals[vertex * 3 + 1],
                data.normals[vertex * 3 + 2],
            },
            Vec4{1.0f, 0.0f, 0.0f, 1.0f},
            Vec2{
                data.uvs[vertex * 2],
                data.uvs[vertex * 2 + 1],
            },
            {},
            position,
        });
    }
    geometry.indices = std::move(data.indices);
    const double major_radius = options.diameter * 0.5;
    const double minor_radius = options.thickness * 0.5;
    const float outer_radius =
        static_cast<float>(major_radius + minor_radius);
    const float minor_extent = static_cast<float>(minor_radius);
    geometry.bounds_min =
        Vec3{-outer_radius, -minor_extent, -outer_radius};
    geometry.bounds_max =
        Vec3{outer_radius, minor_extent, outer_radius};
    for (ModelVertex& vertex : geometry.vertices) {
        vertex.local_position = vertex.position;
    }
    engine.geometries.push_back(std::move(geometry));
    MeshRecord mesh;
    mesh.primitive = PrimitiveKind::torus;
    mesh.name = "${this.context.pinnedFactoryMeshName("createTorus")}";
    mesh.geometry =
        static_cast<std::uint32_t>(engine.geometries.size() - 1);
    engine.meshes.push_back(mesh);
    return MeshHandle{
        static_cast<std::uint32_t>(engine.meshes.size() - 1)};
}

${computeNormals}${discFactory}${cylinderFactory}${polyhedronFactory}${ribbonFactory}
MeshHandle create_mesh_from_data(
    Engine& engine,
    const std::string& name,
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
    mesh.name = name;
    mesh.primitive = PrimitiveKind::gltf;
    mesh.geometry =
        static_cast<std::uint32_t>(engine.geometries.size() - 1);
    engine.meshes.push_back(mesh);
    return MeshHandle{
        static_cast<std::uint32_t>(engine.meshes.size() - 1)};
}

// src/mesh/mesh-factories.ts updateMeshPositions/writeVertexAttributeRange:
// validate the tightly-packed source/destination vertex ranges before
// publishing one new geometry version. The PAL keeps the existing GPU buffer
// and consumes this version in its ordinary pre-draw upload pass.
void update_mesh_positions(
    Engine& engine,
    MeshHandle mesh,
    const std::vector<float>& positions,
    double vertex_offset_value,
    double vertex_count_value,
    double source_vertex_offset_value) {
    if (mesh.value >= engine.meshes.size()) {
        throw std::runtime_error("Invalid mesh handle.");
    }
    MeshRecord& record = engine.meshes[mesh.value];
    if (record.geometry >= engine.geometries.size()) {
        throw std::runtime_error(
            "mesh attribute updates require procedural geometry");
    }
    const std::size_t aliases = static_cast<std::size_t>(std::count_if(
        engine.meshes.begin(),
        engine.meshes.end(),
        [&](const MeshRecord& candidate) {
            return candidate.geometry == record.geometry;
        }));
    if (aliases > 1) {
        throw std::runtime_error(
            "mesh attribute updates require unshared geometry: " +
            record.name);
    }
    const double source_vertex_count_value =
        static_cast<double>(positions.size()) / 3.0;
    const double count_value = std::isnan(vertex_count_value)
        ? source_vertex_count_value - source_vertex_offset_value
        : vertex_count_value;
    const auto valid_index = [](double value) {
        return std::isfinite(value) && value >= 0.0 &&
            std::trunc(value) == value;
    };
    if (
        positions.size() % 3 != 0 ||
        !valid_index(vertex_offset_value) ||
        !valid_index(source_vertex_offset_value) ||
        !valid_index(count_value) ||
        source_vertex_offset_value + count_value >
            source_vertex_count_value) {
        throw std::runtime_error(
            "mesh attribute update requires a valid tightly-packed vertex range");
    }
    ModelGeometry& geometry = engine.geometries[record.geometry];
    const std::size_t vertex_offset =
        static_cast<std::size_t>(vertex_offset_value);
    const std::size_t source_vertex_offset =
        static_cast<std::size_t>(source_vertex_offset_value);
    const std::size_t count = static_cast<std::size_t>(count_value);
    if (vertex_offset + count > geometry.vertices.size()) {
        throw std::runtime_error(
            "mesh attribute update requires a valid destination vertex range");
    }
    if (count == 0) return;
    for (std::size_t index = 0; index < count; ++index) {
        const std::size_t source = (source_vertex_offset + index) * 3;
        ModelVertex& vertex = geometry.vertices[vertex_offset + index];
        vertex.position = Vec3{
            positions[source],
            positions[source + 1],
            positions[source + 2]};
        vertex.local_position = vertex.position;
    }
    ++geometry.position_version;
    ++record.transform_version;
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

${instanceColorSetter}// src/mesh/thin-instance.ts setThinInstanceCount: update only the active
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

// src/mesh/thin-instance.ts setThinInstanceMatrix: overwrite one matrix in
// the adopted caller array and mark its pool version dirty. Native uploads
// the mirrored pool as one buffer, so the version is the complete dirty
// signal even though the pin records a one-slot range.
void set_thin_instance_matrix(
    Engine& engine,
    MeshHandle mesh,
    double index,
    const std::vector<float>& matrix) {
    MeshRecord& record = engine.meshes[mesh.value];
    if (!record.thin_instanced || record.instance_source == nullptr) {
        throw std::runtime_error(
            "setThinInstanceMatrix requires thin instances bound by setThinInstances.");
    }
    const std::size_t slot = static_cast<std::size_t>(index);
    if (slot >= record.instance_matrices.size() || matrix.size() < 16) {
        throw std::runtime_error(
            "setThinInstanceMatrix exceeds its established matrix pool.");
    }
    std::copy_n(matrix.data(), 16, record.instance_matrices[slot].data());
    std::copy_n(
        matrix.data(),
        16,
        record.instance_source->data() + slot * 16);
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

// Direct GPUQueue.writeBuffer helper: copy
// exactly the requested matrix prefix into the established pool and make the
// PAL upload it on the next draw. The source writes count * 64 bytes and does
// not change the active instance count; this function preserves both facts.
void upload_thin_instance_matrices(
    Engine& engine,
    MeshHandle mesh,
    const std::vector<float>& matrices,
    double count) {
    MeshRecord& record = engine.meshes[mesh.value];
    if (!record.thin_instanced) {
        throw std::runtime_error(
            "A direct thin-instance upload requires an established pool.");
    }
    const std::size_t requested = static_cast<std::size_t>(count);
    if (requested > record.instance_matrices.size() ||
        requested > matrices.size() / 16) {
        throw std::runtime_error(
            "A direct thin-instance upload exceeds its matrix buffer.");
    }
    copy_thin_instance_range(record, matrices, requested);
    record.instance_version += 1;
}

} // namespace bbl
`,
        };
    }
}
