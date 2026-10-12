import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { unwrapExpression } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
} from "./pinned-numeric-lowerer.js";
import {
    meshCpuStreamFields,
    meshCpuStreamParameters,
} from "./mesh-cpu-streams.js";
import { recordAt } from "../compiler/record-access.js";
import {
    absentDrawRangeBinding,
    assertDrawRangesUnreached,
} from "./mesh-draw-range.js";

const modulePath = "src/mesh/mesh-factories.ts";
const optionalStreams = new Set(["uvs", "uvs2", "tangents", "colors"]);
const paddedStreams = new Map([
    ["paddedPositions", "positions"],
    ["paddedNormals", "normals"],
    ["paddedIndices", "indices"],
    ["paddedUvs", "uvs"],
    ["paddedUv2s", "uvs2"],
    ["paddedTangents", "tangents"],
    ["paddedColors", "colors"],
]);

/** Source algorithms over retained arrays and PAL byte-storage ports. */
export function lowerMeshGeometryUpdates(context: LoweringContext): string {
    const signatures = [
        [
            "validateGeometryRange",
            "static void validate_geometry_range(const MeshGeometryRange& range, double length)",
        ],
        [
            "matchesGeometryAttribute",
            "static bool matches_geometry_attribute(const std::optional<js::F32Array>& values, bool present, double length)",
        ],
        [
            "validateGeometryRanges",
            "static void validate_geometry_ranges(const js::Array<MeshGeometryRange>& ranges, double length)",
        ],
        [
            "writeGeometryRanges",
            "template<class Buffer, class Values> static void write_geometry_ranges(Buffer buffer, const Values& values, double components, const std::optional<js::Array<MeshGeometryRange>>& ranges)",
        ],
        [
            "retainMeshGeometry",
            `static void retain_updated_mesh_geometry(Engine& engine, MeshHandle mesh, ${meshCpuStreamParameters})`,
        ],
        [
            "validateCapacityGeometry",
            `static double validate_capacity_geometry(Engine& engine, MeshHandle mesh, ${meshCpuStreamParameters})`,
        ],
        [
            "updateMeshGeometry",
            `void update_mesh_geometry(Engine& engine, MeshHandle mesh, ${meshCpuStreamParameters})`,
        ],
        [
            "updateMeshGeometryCapacity",
            `MeshGeometryUpdateResult update_mesh_geometry_capacity(Engine& engine, MeshHandle mesh, ${meshCpuStreamParameters}, std::optional<double> requestedReserveFactor, const std::optional<MeshGeometryRanges>& ranges)`,
        ],
    ] as const;
    return signatures
        .map(([name, signature]) => {
            const { file, declaration } = context.functionDeclaration(
                modulePath,
                name,
            );
            const bindings = new Map<string, PinnedBinding>();
            const bind = (
                key: string,
                cpp: string,
                type: PinnedBinding["type"] = "opaque",
                absentCpp?: string,
            ) =>
                bindings.set(key, {
                    cpp,
                    type,
                    ...(absentCpp ? { absentCpp } : {}),
                });
            const record = recordAt("engine.meshes", "mesh");
            const geometry = (owner: string) =>
                owner === "mesh._gpu"
                    ? `engine.geometries.at(${record}.geometry)`
                    : owner;
            for (const key of ["engine", "mesh", "buffer", "values"])
                bind(key, key);
            for (const key of ["components", "length", "reserveFactor"])
                bind(key, key, "scalar");
            const stream = (key: string, optional: boolean) => {
                const value = optional ? `(*${key})` : key;
                bind(
                    key,
                    key,
                    "opaque",
                    optional ? `!${key}.has_value()` : "false",
                );
                bind(
                    `${key}.length`,
                    `static_cast<double>(${value}.size())`,
                    "scalar",
                );
                bind(
                    `${key}?.length`,
                    `(${key} ? static_cast<double>(${value}.size()) : 0.0)`,
                    "scalar",
                );
                bind(`${key}.buffer`, value);
                bind(`${key}.byteOffset`, "0.0", "scalar");
                bind(
                    `${key}.byteLength`,
                    `static_cast<double>(${value}.byte_length())`,
                    "scalar",
                );
            };
            for (const value of meshCpuStreamFields.values())
                stream(value, optionalStreams.has(value));
            stream("values", false);
            for (const [value, source] of paddedStreams)
                stream(value, optionalStreams.has(source));
            bind("mesh._gpu", `${record}.geometry`, "index");
            for (const owner of ["gpu", "oldGpu", "mesh._gpu"]) {
                const target = geometry(owner);
                bindings.set(
                    `${owner}._drawRangeSource`,
                    absentDrawRangeBinding(context),
                );
                bind(
                    `${owner}._vbLayout`,
                    `!${target}.owned_packed_geometry`,
                    "bool",
                );
                bind(
                    `${owner}._refCount`,
                    `static_cast<double>(${target}.owners)`,
                    "scalar",
                    "false",
                );
                bind(`${owner}.indexFormat`, 'std::string("uint32")', "string");
                bind(
                    `${owner}.indexCount`,
                    `static_cast<double>(${target}.render_indices_override ? ${target}.render_indices_override->size() : ${target}.indices.size())`,
                    "scalar",
                );
                for (const [field, member] of [
                    ["hasUv", "has_uvs"],
                    ["hasUv2", "cpu_uv2s"],
                    ["hasTangent", "has_tangents"],
                    ["hasColor", "has_vertex_colors"],
                ])
                    bind(`${owner}.${field}`, `${target}.${member}`, "bool");
                for (const [field, attribute] of [
                    ["positionBuffer", "Position"],
                    ["normalBuffer", "Normal"],
                    ["uvBuffer", "Uv"],
                    ["uv2Buffer", "Uv2"],
                    ["tangentBuffer", "Tangent"],
                    ["colorBuffer", "Color"],
                ])
                    bind(
                        `${owner}.${field}`,
                        `pal::MeshAttributeBuffer{&${target}, pal::MeshAttribute::${attribute}}`,
                    );
                bind(
                    `${owner}.indexBuffer`,
                    `pal::MeshIndexBuffer{&${target}}`,
                );
                for (const [field, member] of [
                    ["_vertexCapacity", "vertex_capacity"],
                    ["_indexCapacity", "index_capacity"],
                ])
                    bindings.set(`${owner}.${field}`, {
                        cpp: `${target}.${member}.value()`,
                        type: "scalar",
                        nullish: `!${target}.${member}.has_value()`,
                    });
                bind(
                    `${owner}._indexScratch`,
                    `pal::mesh_index_scratch(${target})`,
                    "opaque",
                    `!${target}.index_scratch.has_value()`,
                );
                bind(
                    `${owner}._indexScratch?.length`,
                    `(${target}.index_scratch ? static_cast<double>(${target}.index_scratch->size()) : std::numeric_limits<double>::quiet_NaN())`,
                    "scalar",
                );
            }
            if (name === "retainMeshGeometry") {
                for (const [field, member] of meshCpuStreamFields)
                    bind(`mesh.${field}`, `retained->${member}`);
                bind("mesh._cpuGpuIndices", "retained->indices");
                bind("mesh.boundMin", "minimum");
                bind("mesh.boundMax", "maximum");
                bind("mesh._cpuIndexFormat", "index_format", "string");
            } else {
                for (const [field, member] of meshCpuStreamFields) {
                    bind(
                        `mesh.${field}`,
                        `retained.${member}`,
                        "opaque",
                        `!retained.${member}`,
                    );
                    bind(
                        `mesh.${field}.length`,
                        `static_cast<double>(retained.${member}.size())`,
                        "scalar",
                    );
                    bindings.set(`mesh.${field}?.length`, {
                        cpp: `static_cast<double>(retained.${member}.size())`,
                        type: "scalar",
                        nullish: `!retained.${member}`,
                    });
                }
            }
            if (name === "validateGeometryRange")
                for (const member of ["offset", "count"])
                    bind(member, `range.${member}`, "scalar");
            if (name === "matchesGeometryAttribute") {
                bind("values", "values", "opaque", "!values.has_value()");
                // Read only under `!!` and `===`, where an absent length's
                // `undefined` and NaN agree.
                bind(
                    "values?.length",
                    "(values ? static_cast<double>(values->size()) : std::numeric_limits<double>::quiet_NaN())",
                    "scalar",
                );
                bind("present", "present", "bool");
            }
            if (name === "validateGeometryRanges") bind("ranges", "ranges");
            else bind("ranges", "ranges", "opaque", "!ranges.has_value()");
            for (const member of ["vertices", "indices"]) {
                bind(`ranges.${member}`, `ranges->${member}`);
                bind(
                    `ranges?.${member}`,
                    `(ranges ? std::optional<js::Array<MeshGeometryRange>>{ranges->${member}} : std::nullopt)`,
                );
            }
            const calls = new Map<string, (args: readonly string[]) => string>([
                [
                    "Number.isInteger",
                    (args) => `js::number_is_integer(${args[0]})`,
                ],
                ["Number.isFinite", (args) => `std::isfinite(${args[0]})`],
                ["isFinite", (args) => `std::isfinite(${args[0]})`],
                [
                    "validateGeometryRange",
                    (args) => `(validate_geometry_range)(${args.join(", ")})`,
                ],
                [
                    "matchesGeometryAttribute",
                    (args) =>
                        `(matches_geometry_attribute)(${args.join(", ")})`,
                ],
                [
                    "validateGeometryRanges",
                    (args) => `(validate_geometry_ranges)(${args.join(", ")})`,
                ],
                [
                    "writeGeometryRanges",
                    (args) =>
                        `(write_geometry_ranges)(${args
                            .slice(1)
                            .map((value, index) =>
                                index === 1 && optionalStreams.has(value)
                                    ? `*${value}`
                                    : value,
                            )
                            .join(", ")})`,
                ],
                [
                    "validateCapacityGeometry",
                    (args) =>
                        `(validate_capacity_geometry)(engine, ${args.join(", ")})`,
                ],
                [
                    "retainMeshGeometry",
                    (args) =>
                        `(retain_updated_mesh_geometry)(${args.join(", ")})`,
                ],
                [
                    "resizeMeshGeometry",
                    (args) =>
                        `resize_retained_mesh_geometry(${args.join(", ")})`,
                ],
                [
                    "queue.writeBuffer",
                    (args) =>
                        `pal::write_mesh_geometry_bytes(${args.join(", ")})`,
                ],
                [
                    "computeAabb",
                    (args) =>
                        `compute_aabb(js::typed_array_numbers(${args[0]}))`,
                ],
                [
                    "_markWorldMatrixDirty",
                    (args) => `mark_mesh_dirty(engine, ${args[0]})`,
                ],
                [
                    "engine._dlr.m",
                    () =>
                        `capture_factory_cpu_streams(engine, *retained, indices, retained->uvs2, retained->tangents, retained->colors)`,
                ],
            ]);
            bind("queue", "0");
            const drawRangeReset =
                name === "retainMeshGeometry"
                    ? declaration.body!.statements.slice(0, 2)
                    : [];
            if (drawRangeReset.length) {
                context.assertStatementShapes(
                    declaration,
                    drawRangeReset,
                    `
                    const gpu = mesh._gpu;
                    if (gpu._drawRangeSource && !preserveDrawRange) {
                        gpu._drawRangeSource = undefined;
                        gpu._firstIndex = gpu._baseVertex = undefined;
                        invalidateRenderBundles(engine);
                    }`,
                    "Retained geometry draw-range reset",
                );
                assertDrawRangesUnreached(context);
            }
            const statements = declaration.body!.statements.slice(
                drawRangeReset.length,
            );
            const body = lowerPinnedBody(file, statements, {
                bindings,
                calls,
                foldConditions: false,
                callShapes: new Map([
                    ["validateCapacityGeometry", "scalar"],
                    ["matchesGeometryAttribute", "bool"],
                    ["Number.isInteger", "bool"],
                    ["Number.isFinite", "bool"],
                    ["isFinite", "bool"],
                ]),
                expression(node, lowerer) {
                    node = unwrapExpression(node);
                    // `(owner._drawRangeSource?.stream ?? mesh.stream)?.length`
                    // with the draw-range source absent: the retained stream's
                    // own optional length, compared or defaulted as the pin does.
                    const drawRangeLength = (read: ts.Expression) => {
                        read = unwrapExpression(read);
                        if (
                            !ts.isPropertyAccessExpression(read) ||
                            !read.questionDotToken ||
                            read.name.text !== "length"
                        )
                            return undefined;
                        const choice = unwrapExpression(read.expression);
                        if (
                            !ts.isBinaryExpression(choice) ||
                            choice.operatorToken.kind !==
                                ts.SyntaxKind.QuestionQuestionToken ||
                            !ts.isPropertyAccessExpression(choice.left) ||
                            !ts.isPropertyAccessExpression(
                                choice.left.expression,
                            ) ||
                            choice.left.expression.name.text !==
                                "_drawRangeSource"
                        )
                            return undefined;
                        const source = lowerer.binding(choice.left.expression);
                        const length = bindings.get(
                            `${choice.right.getText(file)}?.length`,
                        );
                        if (!source?.staticallyAbsent || !length?.nullish)
                            return context.contractError(
                                read,
                                "Expected an absent draw-range source over a retained stream length.",
                            );
                        return { cpp: length.cpp, absent: length.nullish };
                    };
                    if (
                        ts.isBinaryExpression(node) &&
                        node.operatorToken.kind ===
                            ts.SyntaxKind.QuestionQuestionToken
                    ) {
                        const length = drawRangeLength(node.left);
                        if (length)
                            return `(${length.absent} ? ${lowerer.expression(node.right)} : ${length.cpp})`;
                    }
                    if (
                        ts.isBinaryExpression(node) &&
                        node.operatorToken.kind ===
                            ts.SyntaxKind.ExclamationEqualsEqualsToken
                    ) {
                        const length = drawRangeLength(node.left);
                        if (length)
                            return `(${length.absent} || ${length.cpp} != ${lowerer.expression(node.right)})`;
                    }
                    if (
                        ts.isCallExpression(node) &&
                        node.expression.getText(file) === "engine._dlr?.m"
                    )
                        context.assertExpressionShape(
                            node,
                            'engine._dlr?.m(mesh, mesh._cpuUv2s, mesh._cpuTangents, mesh._cpuColors, indices, "uint32")',
                            "Retained geometry capture arguments",
                        );
                    if (
                        ts.isBinaryExpression(node) &&
                        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                        node.left.getText(file) === "mesh._cpuIndexFormat"
                    )
                        context.assertExpressionShape(
                            node.right,
                            '"uint32"',
                            "Retained geometry represented index type",
                        );
                    if (
                        ts.isPropertyAccessExpression(node) &&
                        node.questionDotToken &&
                        node.name.text === "length" &&
                        ts.isPropertyAccessExpression(node.expression) &&
                        ts.isIdentifier(node.expression.expression) &&
                        node.expression.expression.text === "mesh"
                    ) {
                        const member = meshCpuStreamFields.get(
                            node.expression.name.text,
                        );
                        if (
                            member &&
                            !(
                                ts.isBinaryExpression(node.parent) &&
                                node.parent.operatorToken.kind ===
                                    ts.SyntaxKind.QuestionQuestionToken
                            )
                        )
                            return `(retained.${member} ? static_cast<double>(retained.${member}.size()) : std::numeric_limits<double>::quiet_NaN())`;
                    }
                    if (
                        node.kind === ts.SyntaxKind.NullKeyword ||
                        (ts.isIdentifier(node) && node.text === "undefined")
                    )
                        return "std::nullopt";
                    if (
                        ts.isNewExpression(node) &&
                        ts.isIdentifier(node.expression) &&
                        ["Float32Array", "Uint32Array"].includes(
                            node.expression.text,
                        )
                    ) {
                        if (node.arguments?.length !== 1)
                            return context.contractError(
                                node,
                                "Expected one typed-array allocation length.",
                            );
                        return `js::${node.expression.text === "Float32Array" ? "f32" : "u32"}_array_sized(${lowerer.expression(node.arguments[0]!)})`;
                    }
                    if (
                        ts.isConditionalExpression(node) &&
                        ts.isIdentifier(node.whenTrue) &&
                        ["min", "max"].includes(node.whenTrue.text)
                    )
                        return `(${lowerer.expression(node.condition)} ? std::optional<std::array<double, 3>>{${lowerer.expression(node.whenTrue)}} : ${lowerer.expression(node.whenFalse)})`;
                    if (
                        ts.isConditionalExpression(node) &&
                        ts.isNewExpression(node.whenTrue) &&
                        ts.isIdentifier(node.whenTrue.expression) &&
                        node.whenTrue.expression.text === "Float32Array"
                    )
                        return `(${lowerer.expression(node.condition)} ? std::optional<js::F32Array>{${lowerer.expression(node.whenTrue)}} : ${lowerer.expression(node.whenFalse)})`;
                    if (
                        ts.isBinaryExpression(node) &&
                        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                        ts.isPropertyAccessExpression(node.left)
                    ) {
                        const field = node.left.name.text;
                        const members = new Map([
                            ["_vertexCapacity", "vertex_capacity"],
                            ["_indexCapacity", "index_capacity"],
                            ["_indexScratch", "index_scratch"],
                        ]);
                        const member = members.get(field);
                        if (member) {
                            const owner = node.left.expression.getText(file);
                            if (!["gpu", "oldGpu", "mesh._gpu"].includes(owner))
                                return context.contractError(
                                    node.left,
                                    "Expected mesh GPU capacity owner.",
                                );
                            return `${geometry(owner)}.${member}.emplace(${lowerer.expression(node.right)})`;
                        }
                    }
                    if (
                        ts.isCallExpression(node) &&
                        ts.isPropertyAccessExpression(node.expression) &&
                        ts.isIdentifier(node.expression.expression)
                    ) {
                        const owner = node.expression.expression.text,
                            member = node.expression.name.text;
                        const source = paddedStreams.get(owner);
                        if (source && ["set", "fill"].includes(member)) {
                            const optional = optionalStreams.has(source);
                            const args = node.arguments.map((argument) =>
                                lowerer.expression(argument),
                            );
                            if (member === "fill")
                                return `js::array_fill(${owner}, static_cast<typename decltype(${owner})::value_type>(${args[0]}))`;
                            const value = optional ? `*${args[0]}` : args[0];
                            const call = `js::typed_array_set(${optional ? `*${owner}` : owner}, ${value}, ${args[1] ?? "0.0"})`;
                            if (!!node.expression.questionDotToken !== optional)
                                return context.contractError(
                                    node,
                                    "Expected optional padded stream set.",
                                );
                            return optional
                                ? `([&] { if (${owner}) ${call}; }())`
                                : call;
                        }
                    }
                    return undefined;
                },
                statement(node, lowerer, indent) {
                    if (
                        ts.isExpressionStatement(node) &&
                        ts.isBinaryExpression(node.expression) &&
                        node.expression.operatorToken.kind ===
                            ts.SyntaxKind.EqualsToken &&
                        ts.isPropertyAccessExpression(node.expression.left) &&
                        [
                            "_vertexCapacity",
                            "_indexCapacity",
                            "_indexScratch",
                        ].includes(node.expression.left.name.text)
                    )
                        return [
                            `${indent}(void)${lowerer.expression(node.expression)};`,
                        ];
                    if (
                        ts.isForOfStatement(node) &&
                        ts.isVariableDeclarationList(node.initializer)
                    ) {
                        const variable = node.initializer.declarations[0];
                        if (variable && ts.isIdentifier(variable.name)) {
                            context.assertExpressionShape(
                                node.expression,
                                "ranges",
                                "Geometry range iteration",
                            );
                            lowerer.bindLocal(variable.name, {
                                cpp: "range",
                                type: "opaque",
                            });
                            return [
                                `${indent}for (const auto& range : ranges) {`,
                                ...lowerer.statement(
                                    node.statement,
                                    indent + "    ",
                                ),
                                `${indent}}`,
                            ];
                        }
                        if (
                            !variable ||
                            !ts.isObjectBindingPattern(variable.name)
                        )
                            return undefined;
                        if (variable.name.elements.length !== 2)
                            return context.contractError(
                                variable,
                                "Expected offset/count range destructuring.",
                            );
                        for (const element of variable.name.elements) {
                            if (
                                !ts.isIdentifier(element.name) ||
                                !["offset", "count"].includes(
                                    element.name.text,
                                ) ||
                                element.propertyName ||
                                element.initializer ||
                                element.dotDotDotToken
                            )
                                return context.contractError(
                                    element,
                                    "Expected offset/count range member.",
                                );
                            lowerer.bindLocal(element.name, {
                                cpp: `range.${element.name.text}`,
                                type: "scalar",
                            });
                        }
                        return [
                            `${indent}for (const auto& range : ${name === "validateGeometryRanges" ? "ranges" : "*ranges"}) {`,
                            ...lowerer.statement(
                                node.statement,
                                indent + "    ",
                            ),
                            `${indent}}`,
                        ];
                    }
                    if (
                        !ts.isVariableStatement(node) ||
                        node.declarationList.declarations.length !== 1
                    )
                        return undefined;
                    const variable = node.declarationList.declarations[0]!;
                    if (!variable.initializer) return undefined;
                    if (ts.isArrayBindingPattern(variable.name)) {
                        context.assertExpressionShape(
                            variable.initializer,
                            "computeAabb(positions)",
                            "Retained geometry bounds fold",
                        );
                        if (variable.name.elements.length !== 2)
                            return context.contractError(
                                variable,
                                "Expected bounds pair.",
                            );
                        variable.name.elements.forEach((element, index) => {
                            if (
                                !ts.isBindingElement(element) ||
                                !ts.isIdentifier(element.name)
                            )
                                return context.contractError(
                                    element,
                                    "Expected bounds tuple member.",
                                );
                            lowerer.bindLocal(element.name, {
                                cpp: `bounds[${index}]`,
                                type: "f64-buffer",
                                indexedRead: (owner, offset) =>
                                    `${owner}[static_cast<std::size_t>(${offset})]`,
                            });
                        });
                        return [
                            `${indent}const auto bounds = ${lowerer.expression(variable.initializer)};`,
                        ];
                    }
                    if (!ts.isIdentifier(variable.name)) return undefined;
                    const local = variable.name.text;
                    if (local === "queue") {
                        context.assertExpressionShape(
                            variable.initializer,
                            "engine._device.queue",
                            "Geometry upload queue",
                        );
                        return [];
                    }
                    if (["gpu", "oldGpu"].includes(local)) {
                        context.assertExpressionShape(
                            variable.initializer,
                            "mesh._gpu",
                            "Geometry GPU owner",
                        );
                        lowerer.bindLocal(variable.name, {
                            cpp: local,
                            type: "opaque",
                        });
                        return [
                            `${indent}auto& ${local} = engine.geometries.at(${lowerer.expression(variable.initializer)});`,
                        ];
                    }
                    const source = paddedStreams.get(local);
                    if (source) {
                        const optional = optionalStreams.has(source);
                        lowerer.bindLocal(variable.name, {
                            cpp: local,
                            type: "opaque",
                            absentCpp: optional ? `!${local}` : "false",
                        });
                        return [
                            `${indent}${optional ? "std::optional<js::F32Array>" : source === "indices" ? "js::U32Array" : "js::F32Array"} ${local} = ${lowerer.expression(variable.initializer)};`,
                        ];
                    }
                    return undefined;
                },
                returnValue(node, lowerer) {
                    if (!node) return "";
                    if (ts.isObjectLiteralExpression(node)) {
                        const fields = [
                            "stable",
                            "vertexCapacity",
                            "indexCapacity",
                        ].map((field) => {
                            const property = context.propertyInitializer(
                                node,
                                field,
                            );
                            return lowerer.expression(property);
                        });
                        return `MeshGeometryUpdateResult{${fields.join(", ")}}`;
                    }
                    return lowerer.expression(node);
                },
            });
            let before = "",
                after = "";
            if (name === "retainMeshGeometry") {
                before =
                    "    auto retained = std::make_shared<MeshCpuStreams>();\n    std::optional<std::array<double, 3>> minimum, maximum;\n    [[maybe_unused]] std::string index_format;\n";
                after =
                    "\n    pal::retain_mesh_geometry_snapshot(engine, mesh, std::move(retained), minimum, maximum);";
            } else if (
                ["updateMeshGeometry", "updateMeshGeometryCapacity"].includes(
                    name,
                )
            )
                before = `    const MeshCpuStreamsView retained(${record}, &${geometry("mesh._gpu")});\n`;
            if (name === "updateMeshGeometryCapacity") {
                const initial = declaration.parameters[9]?.initializer;
                if (!initial)
                    return context.contractError(
                        declaration,
                        "Expected capacity reserve default.",
                    );
                const value = new PinnedNumericLowerer(file, {
                    bindings: new Map(),
                    calls: new Map(),
                }).expression(initial);
                before += `    const double reserveFactor = requestedReserveFactor.value_or(${value});\n`;
            }
            return `// ${context.provenance(modulePath, name)}\n${signature} {\n${before}${body}${after}\n}`;
        })
        .join("\n");
}
