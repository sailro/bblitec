/**
 * `createTube` and `createExtrudeShape`, lowered from their pinned chain:
 * `createTubeData` (src/mesh/create-tube.ts) and `createExtrudeShapeData`
 * (src/mesh/create-extrude.ts) sweep a cross-section along
 * `computePath3D`'s Frenet frames (src/mesh/path3d.ts) and hand the rows to
 * `createRibbonData`, which the factory unit lowers once for every builder
 * that finishes through it, under the pinned factory's own mesh name.
 *
 * Every body here is translated from its declaration: the vector helpers,
 * the path frames and both sweeps. The one specialized part is each sweep's
 * option head: the compiler intrinsic names the path, radius, tessellation,
 * scale and rotation and refuses the cap, arc and radius-function options,
 * so the cap is the pin's `CAP_NONE`, the arc its own `?? 1` fallback and
 * the radius function absent -- which is what leaves the cap and
 * radius-function arms untranslated.
 *
 * Widths follow the pin exactly: every intermediate is a JS double, and the
 * only float rounding is `createMeshFromData`'s own typed-array stores.
 */
import ts from "typescript";
import { LoweredSource, LoweringContext } from "../context.js";
import { lowerPinnedBody } from "../pinned-body-lowerer.js";
import {
    lowerObjectComponents,
    lowerPinnedFunction,
    type PinnedFunctionParameter,
} from "../pinned-function-lowerer.js";
import {
    absentBinding,
    type PinnedBinding,
    type PinnedNumericLowerer,
    recordLiteralCpp,
} from "../pinned-numeric-lowerer.js";

import { pinnedOptionNumber } from "../pinned-option-defaults.js";

/** A pinned `Vec3` parameter, landing on the runtime's double record. */
function vec3Parameter(pinned: string): PinnedFunctionParameter {
    return {
        pinned,
        kind: "record",
        cpp: pinned,
        cppType: "Vec3d",
        annotation: "Vec3",
    };
}

/** A pinned `Vec3[]` parameter, read as the runtime's double record list. */
function vec3ListParameter(pinned: string): PinnedFunctionParameter {
    return {
        pinned,
        kind: "record",
        cpp: pinned,
        cppType: "std::vector<Vec3d>",
        annotation: "Vec3[]",
        binding: { cpp: pinned, type: "vec3-list" },
    };
}

/** The three members a body reads off each named `Vec3` parameter. */
function vec3Members(...names: readonly string[]): Map<string, PinnedBinding> {
    return new Map(
        names.flatMap((name) =>
            ["x", "y", "z"].map((lane): [string, PinnedBinding] => [
                `${name}.${lane}`,
                { cpp: `${name}.${lane}`, type: "scalar" },
            ]),
        ),
    );
}

const PATH_MODULE = "src/mesh/path3d.ts";
const TUBE_MODULE = "src/mesh/create-tube.ts";
const EXTRUDE_MODULE = "src/mesh/create-extrude.ts";

export class TubeLowerer {
    public constructor(private readonly context: LoweringContext) {}

    /**
     * The pinned vector arithmetic the frames and the sweeps call, by pinned
     * name: each a C++ spelling of a helper lowered below, and each
     * returning the `Vec3` record every one of them hands back.
     */
    private readonly vectorCalls = new Map<
        string,
        (args: readonly string[]) => string
    >([
        ...(
            [
                ["lengthVec3", "tube_length"],
                ["subtractVec3", "tube_sub"],
                ["crossVec3", "tube_cross"],
                ["normalizeVec3", "tube_normalize"],
                ["rodrigues", "tube_rodrigues"],
                ["withinEpsilon", "tube_within_epsilon"],
                ["getFirstNonNullVector", "tube_first_non_null"],
                ["getLastNonNullVector", "tube_last_non_null"],
            ] as const
        ).map(
            ([pinned, cpp]): [string, (args: readonly string[]) => string] => [
                pinned,
                (args) => `${cpp}(${args.join(", ")})`,
            ],
        ),
        ["vec3", (args) => recordLiteralCpp("vec3", args)],
    ]);

    private readonly vectorShapes = new Map<string, PinnedBinding["type"]>(
        [
            "subtractVec3",
            "crossVec3",
            "normalizeVec3",
            "rodrigues",
            "getFirstNonNullVector",
            "getLastNonNullVector",
            "normalVector",
            "vec3",
        ].map((name) => [name, "vec3"]),
    );

    private readonly vec3Literal = (
        type: PinnedBinding["type"],
        components: readonly string[],
    ): string =>
        type === "vec3"
            ? recordLiteralCpp("vec3", components)
            : this.context.contractError(
                  this.context.sourceFile(PATH_MODULE),
                  `A sweep builds only Vec3 records, not ${type}.`,
              );

    private returnsVec3(modulePath: string, symbolName: string) {
        return {
            type: "Vec3d",
            value: (
                lowerer: PinnedNumericLowerer,
                expression: ts.Expression | undefined,
            ): string => {
                const returned = expression
                    ? this.context.unwrapExpression(expression)
                    : this.context.contractError(
                          this.context.functionDeclaration(
                              modulePath,
                              symbolName,
                          ).declaration,
                          `Expected pinned ${symbolName} to return a value.`,
                      );
                return ts.isObjectLiteralExpression(returned)
                    ? recordLiteralCpp(
                          "vec3",
                          lowerObjectComponents(
                              this.context,
                              lowerer,
                              returned,
                              ["x", "y", "z"],
                          ),
                      )
                    : lowerer.expression(returned);
            },
        };
    }

    /**
     * The five pinned vector helpers the sweep and the Frenet chain call,
     * each translated whole from its own declaration: the three `Vec3`
     * arithmetic modules, the object normalization (whose degenerate arm
     * answers zero below `1e-10`), and the tube's own Rodrigues rotation.
     */
    private lowerVectorHelpers(): string {
        const lengthModule = "src/math/length-vec3.ts";
        const subModule = "src/math/subtract-vec3.ts";
        const crossModule = "src/math/cross-vec3.ts";
        const normalizeModule = "src/math/normalize-vec3.ts";
        return [
            lowerPinnedFunction(
                this.context,
                lengthModule,
                "lengthVec3",
                [vec3Parameter("v")],
                {
                    cppName: "tube_length",
                    returns: "double",
                    calls: this.vectorCalls,
                    memberBindings: vec3Members("v"),
                },
            ),
            lowerPinnedFunction(
                this.context,
                subModule,
                "subtractVec3",
                [vec3Parameter("a"), vec3Parameter("b")],
                {
                    cppName: "tube_sub",
                    returns: this.returnsVec3(subModule, "subtractVec3"),
                    calls: this.vectorCalls,
                    memberBindings: vec3Members("a", "b"),
                },
            ),
            lowerPinnedFunction(
                this.context,
                crossModule,
                "crossVec3",
                [vec3Parameter("a"), vec3Parameter("b")],
                {
                    cppName: "tube_cross",
                    returns: this.returnsVec3(crossModule, "crossVec3"),
                    calls: this.vectorCalls,
                    memberBindings: vec3Members("a", "b"),
                },
            ),
            lowerPinnedFunction(
                this.context,
                normalizeModule,
                "normalizeVec3",
                [vec3Parameter("v")],
                {
                    cppName: "tube_normalize",
                    returns: this.returnsVec3(normalizeModule, "normalizeVec3"),
                    calls: this.vectorCalls,
                    memberBindings: vec3Members("v"),
                },
            ),
            lowerPinnedFunction(
                this.context,
                TUBE_MODULE,
                "rodrigues",
                [
                    vec3Parameter("v"),
                    vec3Parameter("k"),
                    { pinned: "angle", kind: "number", cpp: "angle" },
                ],
                {
                    cppName: "tube_rodrigues",
                    returns: this.returnsVec3(TUBE_MODULE, "rodrigues"),
                    calls: this.vectorCalls,
                    memberBindings: vec3Members("v", "k"),
                },
            ),
        ].join("\n\n");
    }

    /**
     * `computePath3D` and the helpers it calls, lowered from path3d.ts. The
     * reached sweeps pass no first normal, so `normalVector` is its
     * `va === null` arm and the frames' `firstNormal` is statically absent.
     * The one platform boundary is `new Array(l)`: each frame list is a
     * native vector of `l` records (or numbers) the body then fills.
     */
    private lowerPathFrames(): string {
        const epsilon = lowerPinnedFunction(
            this.context,
            PATH_MODULE,
            "withinEpsilon",
            [
                { pinned: "a", kind: "number", cpp: "a" },
                { pinned: "b", kind: "number", cpp: "b" },
                { pinned: "eps", kind: "number", cpp: "eps" },
            ],
            {
                cppName: "tube_within_epsilon",
                returns: {
                    type: "bool",
                    value: (lowerer, expression) =>
                        expression
                            ? lowerer.expression(expression)
                            : this.context.contractError(
                                  this.context.sourceFile(PATH_MODULE),
                                  "Expected withinEpsilon to return a test.",
                              ),
                },
                calls: this.vectorCalls,
            },
        );
        const nonNull = (
            symbol: "getFirstNonNullVector" | "getLastNonNullVector",
            cppName: string,
        ): string =>
            lowerPinnedFunction(
                this.context,
                PATH_MODULE,
                symbol,
                [
                    vec3ListParameter("curve"),
                    { pinned: "index", kind: "number", cpp: "index" },
                ],
                {
                    cppName,
                    returns: this.returnsVec3(PATH_MODULE, symbol),
                    calls: this.vectorCalls,
                    callShapes: this.vectorShapes,
                },
            );
        const normalVector = lowerPinnedFunction(
            this.context,
            PATH_MODULE,
            "normalVector",
            [
                vec3Parameter("vt"),
                {
                    pinned: "va",
                    kind: "record",
                    cpp: "va",
                    annotation: "Vec3 | null",
                    specialized: true,
                    binding: absentBinding("null"),
                },
            ],
            {
                cppName: "tube_normal_vector",
                returns: this.returnsVec3(PATH_MODULE, "normalVector"),
                calls: this.vectorCalls,
                callShapes: this.vectorShapes,
                memberBindings: vec3Members("vt"),
                armOf: { condition: "va === null", arm: "then" },
            },
        );
        const { file, declaration } = this.context.functionDeclaration(
            PATH_MODULE,
            "computePath3D",
        );
        const bindings = new Map<string, PinnedBinding>([
            ["curve", { cpp: "curve", type: "vec3-list" }],
            ["firstNormal", absentBinding("null")],
        ]);
        const frameLists = new Map<string, PinnedBinding["type"]>([
            ["tangents", "vec3-list"],
            ["normals", "vec3-list"],
            ["binormals", "vec3-list"],
            ["distances", "f64-list"],
        ]);
        const body = lowerPinnedBody(file, declaration.body!.statements, {
            bindings,
            calls: new Map([
                ...this.vectorCalls,
                [
                    "normalVector",
                    (args: readonly string[]) =>
                        args.length === 2 && args[1] === absentBinding().cpp
                            ? `tube_normal_vector(${args[0]})`
                            : this.context.contractError(
                                  declaration,
                                  "Expected computePath3D to pass its absent first normal.",
                              ),
                ],
            ]),
            callShapes: this.vectorShapes,
            recordLiteral: this.vec3Literal,
            vec3Literal: (x, y, z) => recordLiteralCpp("vec3", [x, y, z]),

            returnValue: (expression, lowerer) => {
                const returned = expression
                    ? this.context.unwrapExpression(expression)
                    : undefined;
                if (
                    !returned ||
                    !ts.isObjectLiteralExpression(returned) ||
                    returned.properties.some(
                        (property, index) =>
                            !ts.isShorthandPropertyAssignment(property) ||
                            property.name.text !==
                                [...frameLists.keys()][index],
                    ) ||
                    returned.properties.length !== frameLists.size
                ) {
                    return this.context.contractError(
                        returned ?? declaration,
                        "Expected computePath3D to return its four frame lists.",
                    );
                }
                return `TubePath3D{${returned.properties
                    .map((property) => {
                        if (!ts.isShorthandPropertyAssignment(property))
                            return this.context.contractError(
                                property,
                                "Expected a named frame list.",
                            );
                        return lowerer.expression(property.name);
                    })
                    .join(", ")}}`;
            },
            statement: (statement, lowerer, indent) => {
                if (!ts.isVariableStatement(statement)) return undefined;
                const [local] = statement.declarationList.declarations;
                const initializer = local?.initializer
                    ? this.context.unwrapExpression(local.initializer)
                    : undefined;
                if (
                    !local ||
                    !initializer ||
                    !ts.isNewExpression(initializer) ||
                    !ts.isIdentifier(initializer.expression) ||
                    initializer.expression.text !== "Array"
                ) {
                    return undefined;
                }
                const name = local.name.getText(file);
                const shape = frameLists.get(name);
                if (!shape || initializer.arguments?.length !== 1) {
                    return this.context.contractError(
                        local,
                        "Expected one of computePath3D's sized frame lists.",
                    );
                }
                lowerer.bindPorts(
                    [[name, { cpp: name, type: shape }]],
                    statement,
                );
                return [
                    `${indent}std::vector<${shape === "vec3-list" ? "Vec3d" : "double"}> ${name}(` +
                        `static_cast<std::size_t>(${lowerer.expression(initializer.arguments[0]!)}));`,
                ];
            },
        });
        return `${epsilon}

${nonNull("getFirstNonNullVector", "tube_first_non_null")}

${nonNull("getLastNonNullVector", "tube_last_non_null")}

${normalVector}

struct TubePath3D {
    std::vector<Vec3d> tangents;
    std::vector<Vec3d> normals;
    std::vector<Vec3d> binormals;
    std::vector<double> distances;
};

// ${this.context.provenance(PATH_MODULE, "computePath3D")}
TubePath3D tube_compute_path(const std::vector<Vec3d>& curve) {
${body}
}`;
    }

    /**
     * One sweep builder as a native function returning the `RibbonOptions`
     * its `createRibbonData` call is handed.
     *
     * The option head binds what the intrinsic resolved: the named options
     * the native call passes, and the cap it refuses as the pin's
     * `CAP_NONE`. The re-clamp of that cap is the one statement dropped,
     * and each helper closure the cap arms would call binds as a name that
     * is never read, because those arms fold away. Two platform boundaries
     * remain: the frames arrive as the native `TubePath3D`, and a `Vec3`
     * literal appended to a row lands as that row's native record.
     */
    private lowerSweep(
        module: typeof TUBE_MODULE | typeof EXTRUDE_MODULE,
        symbol: "createTubeData" | "createExtrudeShapeData",
        signature: string,
        options: ReadonlyMap<string, PinnedBinding>,
        locals: ReadonlyMap<string, PinnedBinding>,
        rodrigues: "tube_rodrigues" | "extrude_rodrigues",
    ): string {
        const { file, declaration } = this.context.functionDeclaration(
            module,
            symbol,
        );
        const capClamp = declaration.body!.statements.filter(
            (statement) =>
                ts.isExpressionStatement(statement) &&
                ts.isBinaryExpression(statement.expression) &&
                statement.expression.operatorToken.kind ===
                    ts.SyntaxKind.EqualsToken &&
                statement.expression.left.getText(file) === "cap",
        );
        if (capClamp.length !== 1) {
            this.context.contractError(
                declaration,
                `Expected ${symbol} to re-clamp its cap once.`,
            );
        }
        this.context.assertExpressionShape(
            (capClamp[0] as ts.ExpressionStatement).expression,
            "cap = cap < 0 || cap > 3 ? CAP_NONE : cap",
            `${symbol} cap clamp`,
        );
        const bindings = new Map<string, PinnedBinding>([
            ["Math.PI", { cpp: "pi_double", type: "scalar" }],
            ...options,
            ...locals,
        ]);
        const body = lowerPinnedBody(
            file,
            declaration.body!.statements.filter(
                (statement) => statement !== capClamp[0],
            ),
            {
                bindings,
                calls: new Map([
                    ...this.vectorCalls,
                    [
                        "rodrigues",
                        (args: readonly string[]) =>
                            `${rodrigues}(${args.join(", ")})`,
                    ],
                ]),
                callShapes: this.vectorShapes,
                recordLiteral: this.vec3Literal,
                vec3Literal: (x, y, z) => recordLiteralCpp("vec3", [x, y, z]),

                returnValue: (expression, lowerer) => {
                    const call = expression
                        ? this.context.unwrapExpression(expression)
                        : undefined;
                    const ribbon =
                        call &&
                        ts.isCallExpression(call) &&
                        call.expression.getText(file) === "createRibbonData" &&
                        call.arguments.length === 1
                            ? this.context.unwrapExpression(call.arguments[0]!)
                            : undefined;
                    if (!ribbon || !ts.isObjectLiteralExpression(ribbon)) {
                        return this.context.contractError(
                            call ?? declaration,
                            `Expected ${symbol} to finish through createRibbonData.`,
                        );
                    }
                    const member = (name: string): string =>
                        lowerer.expression(
                            this.context.propertyInitializer(ribbon, name),
                        );
                    return `RibbonOptions{std::move(${member("pathArray")}), ${member("closeArray")}, ${member("closePath")}}`;
                },
                statement: (statement, lowerer, indent) => {
                    if (ts.isVariableStatement(statement)) {
                        const [local] = statement.declarationList.declarations;
                        const initializer = local?.initializer
                            ? this.context.unwrapExpression(local.initializer)
                            : undefined;
                        if (!local || !initializer) return undefined;
                        // `const rows: Vec3[][] = []`: the rows the sweep
                        // grows and hands to the ribbon.
                        if (
                            ts.isArrayLiteralExpression(initializer) &&
                            initializer.elements.length === 0 &&
                            local.type?.getText(file) === "Vec3[][]"
                        ) {
                            const name = local.name.getText(file);
                            lowerer.bindPorts(
                                [
                                    [
                                        name,
                                        {
                                            cpp: name,
                                            type: "vec3-list-2d",
                                        },
                                    ],
                                ],
                                statement,
                            );
                            return [
                                `${indent}std::vector<std::vector<Vec3d>> ${name};`,
                            ];
                        }
                        // `const path3D = computePath3D(curve)`: the frames
                        // as the native record the lowered chain returns.
                        if (
                            ts.isCallExpression(initializer) &&
                            initializer.expression.getText(file) ===
                                "computePath3D"
                        ) {
                            const name = local.name.getText(file);
                            if (initializer.arguments.length !== 1) {
                                return this.context.contractError(
                                    initializer,
                                    "Expected the sweep to compute its frames from the path alone.",
                                );
                            }
                            lowerer.bindPorts(
                                [[name, { cpp: name, type: "opaque" }]],
                                statement,
                            );
                            return [
                                `${indent}const TubePath3D ${name} = tube_compute_path(${lowerer.expression(initializer.arguments[0]!)});`,
                            ];
                        }
                        // `const { tangents, ... } = path3D`: each list read
                        // in place off that record.
                        if (ts.isObjectBindingPattern(local.name)) {
                            const frames = lowerer.binding(initializer);
                            if (frames?.type !== "opaque") {
                                return this.context.contractError(
                                    local,
                                    "Expected the sweep to destructure its frames.",
                                );
                            }
                            for (const element of local.name.elements) {
                                const name = element.name.getText(file);
                                if (
                                    element.propertyName ||
                                    element.initializer ||
                                    ![
                                        "tangents",
                                        "normals",
                                        "binormals",
                                        "distances",
                                    ].includes(name)
                                ) {
                                    return this.context.contractError(
                                        element,
                                        "Expected a frame list by its own name.",
                                    );
                                }
                                lowerer.bindPorts(
                                    [
                                        [
                                            name,
                                            {
                                                cpp: `${frames.cpp}.${name}`,
                                                type:
                                                    name === "distances"
                                                        ? "f64-list"
                                                        : "vec3-list",
                                            },
                                        ],
                                    ],
                                    statement,
                                );
                            }
                            return [];
                        }
                        return undefined;
                    }
                    // `row.push({ x, y, z })`: a Vec3 literal appended to
                    // a row, as that row's native record.
                    if (
                        ts.isExpressionStatement(statement) &&
                        ts.isCallExpression(statement.expression) &&
                        ts.isPropertyAccessExpression(
                            statement.expression.expression,
                        ) &&
                        statement.expression.expression.name.text === "push"
                    ) {
                        const call = statement.expression;
                        const receiver =
                            call.expression as ts.PropertyAccessExpression;
                        const list = lowerer.binding(receiver.expression);
                        const [point] = call.arguments;
                        const literal = point
                            ? this.context.unwrapExpression(point)
                            : undefined;
                        if (
                            list?.type !== "vec3-list" ||
                            call.arguments.length !== 1 ||
                            !literal ||
                            !ts.isObjectLiteralExpression(literal)
                        ) {
                            return undefined;
                        }
                        return [
                            `${indent}${list.cpp}.push_back(${recordLiteralCpp(
                                "vec3",
                                lowerObjectComponents(
                                    this.context,
                                    lowerer,
                                    literal,
                                    ["x", "y", "z"],
                                ),
                            )});`,
                        ];
                    }
                    return undefined;
                },
            },
        );
        return `// ${this.context.provenance(module, symbol)}
${signature} {
${body}
}`;
    }

    /**
     * The pinned cap modes (declared by create-tube.ts and re-exported by
     * create-extrude.ts), and the refused cap option as the `CAP_NONE` it
     * resolves to.
     */
    private capBindings(): [string, PinnedBinding][] {
        const file = this.context.sourceFile(TUBE_MODULE);
        const constant = (name: string): PinnedBinding => {
            const value = this.context.numericValue(
                this.context.variableInitializer(file, name),
                file,
            );
            return {
                cpp: this.context.doubleLiteral(value),
                type: "scalar",
                staticNumber: value,
            };
        };
        return [
            ...(["CAP_NONE", "CAP_START", "CAP_END", "CAP_ALL"] as const).map(
                (name): [string, PinnedBinding] => [name, constant(name)],
            ),
            ["cap", constant("CAP_NONE")],
        ];
    }

    private lowerTubeData(): string {
        const { file, declaration } = this.context.functionDeclaration(
            TUBE_MODULE,
            "createTubeData",
        );
        // The arc is the pin's own fallback when no option is given, inside
        // the guard ternary that clamps a supplied one.
        const arcValue = pinnedOptionNumber(
            this.context,
            declaration,
            { wrapped: "arc" },
            file,
        );
        return this.lowerSweep(
            TUBE_MODULE,
            "createTubeData",
            "RibbonOptions pinned_create_tube_data(\n    const std::vector<Vec3d>& path_points,\n    double radius_option,\n    double tessellation_option)",
            new Map<string, PinnedBinding>([
                ["options.path", { cpp: "path_points", type: "vec3-list" }],
                ["options.radius", { cpp: "radius_option", type: "scalar" }],
                [
                    "options.tessellation",
                    { cpp: "tessellation_option", type: "scalar" },
                ],
            ]),
            new Map<string, PinnedBinding>([
                ["radiusFunction", absentBinding()],
                ...this.capBindings(),
                [
                    "arc",
                    {
                        cpp: this.context.doubleLiteral(arcValue),
                        type: "scalar",
                        staticNumber: arcValue,
                    },
                ],
                ["capPath", { cpp: "capPath", type: "opaque" }],
            ]),
            "tube_rodrigues",
        );
    }

    /** create-extrude.ts declares its own `rodrigues`, which its sweep calls. */
    private lowerExtrudeRodrigues(): string {
        return lowerPinnedFunction(
            this.context,
            EXTRUDE_MODULE,
            "rodrigues",
            [
                vec3Parameter("v"),
                vec3Parameter("k"),
                { pinned: "angle", kind: "number", cpp: "angle" },
            ],
            {
                cppName: "extrude_rodrigues",
                returns: this.returnsVec3(EXTRUDE_MODULE, "rodrigues"),
                calls: this.vectorCalls,
                memberBindings: vec3Members("v", "k"),
            },
        );
    }

    private lowerExtrudeData(): string {
        return this.lowerSweep(
            EXTRUDE_MODULE,
            "createExtrudeShapeData",
            "RibbonOptions pinned_create_extrude_shape_data(\n    const std::vector<Vec3d>& shape_points,\n    const std::vector<Vec3d>& curve_points,\n    double scale_option,\n    double rotation_option)",
            new Map<string, PinnedBinding>([
                ["options.shape", { cpp: "shape_points", type: "vec3-list" }],
                ["options.path", { cpp: "curve_points", type: "vec3-list" }],
                ["options.scale", { cpp: "scale_option", type: "scalar" }],
                [
                    "options.rotation",
                    { cpp: "rotation_option", type: "scalar" },
                ],
            ]),
            new Map<string, PinnedBinding>([
                ...this.capBindings(),
                ["barycenterCap", { cpp: "barycenterCap", type: "opaque" }],
            ]),
            "extrude_rodrigues",
        );
    }

    public lowerTube(extrudeShapes = false): LoweredSource {
        const tubeName = this.context.pinnedFactoryMeshName("createTube");
        const extrudeName =
            this.context.pinnedFactoryMeshName("createExtrudeShape");
        return {
            modulePath: TUBE_MODULE,
            symbolName: "createTubeData",
            header: "",
            source: `// ${this.context.provenance(
                TUBE_MODULE,
                "createTube, createTubeData, rodrigues",
                `src/mesh/path3d.ts computePath3D${extrudeShapes ? ", src/mesh/create-extrude.ts createExtrudeShapeData" : ""}`,
            )}
#include <bblite/js_data.hpp>
#include <bblite/runtime.hpp>

#include <cmath>
#include <cstdint>
#include <stdexcept>
#include <utility>
#include <vector>

namespace bbl {
namespace {

${this.lowerVectorHelpers()}

${this.lowerPathFrames()}

${this.lowerTubeData()}
${extrudeShapes ? `\n${this.lowerExtrudeRodrigues()}\n\n${this.lowerExtrudeData()}\n` : ""}
} // namespace

MeshHandle create_tube(
    Engine& engine,
    const std::vector<Vec3d>& path_points,
    double radius,
    double tessellation_option) {
    return create_ribbon_mesh(
        engine,
        pinned_create_tube_data(path_points, radius, tessellation_option),
        "${tubeName}");
}
${
    !extrudeShapes
        ? ""
        : `
MeshHandle create_extrude_shape(
    Engine& engine,
    const std::vector<Vec3d>& shape,
    const std::vector<Vec3d>& curve,
    double scale,
    double rotation) {
    return create_ribbon_mesh(
        engine,
        pinned_create_extrude_shape_data(shape, curve, scale, rotation),
        "${extrudeName}");
}
`
}
} // namespace bbl
`,
        };
    }
}
