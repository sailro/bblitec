import ts from "typescript";
import { type LoweringContext, unwrapExpression } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import {
    absentBinding,
    type PinnedBinding,
    type PinnedNumericScope,
} from "./pinned-numeric-lowerer.js";
import {
    pinnedRecordLiteral,
    pinnedRecordSchema,
} from "./pinned-record-literal.js";
import { webgpuFlagNamespaces } from "../webgpu-flags.js";
import { absentDrawRangeBinding } from "./mesh-draw-range.js";
import { recordAt } from "../compiler/record-access.js";
import {
    sameSource,
    soleBindingName,
    isOneOfSources,
} from "../compiler/syntax.js";

const cpuModule = "src/mesh/thin-instance.ts";
const gpuModule = "src/mesh/thin-instance-gpu.ts";
const fields = {
    matrices: "matrices",
    count: "count",
    _capacity: "capacity",
    _version: "version",
    _gpuBuffer: "gpu_buffer",
    _gpuVersion: "gpu_version",
    _dirtyMin: "dirty_min",
    _dirtyMax: "dirty_max",
    colors: "colors",
    _colorVersion: "color_version",
    _colorDirtyMin: "color_dirty_min",
    _colorDirtyMax: "color_dirty_max",
    _colorGpuBuffer: "color_gpu_buffer",
    _colorGpuBufferStorage: "color_gpu_buffer_storage",
    _colorGpuVersion: "color_gpu_version",
    _drawArgsBuffer: "draw_args_buffer",
    _drawArgsData: "draw_args_data",
    _drawArgsInstanceCount: "draw_args_instance_count",
    _uploadF32: "upload_f32",
    _gpuCullingEnabled: "gpu_culling_enabled",
    _cullBoundsPad: "cull_bounds_pad",
} as const;
const optionalArrays = new Map<string, "f32" | "u32">([
    ["colors", "f32"],
    ["_uploadF32", "f32"],
    ["_drawArgsData", "u32"],
]);
const arrayProperties = new Map([
    ["buffer", "buffer()"],
    ["byteOffset", "byte_offset()"],
    ["byteLength", "byte_length()"],
]);

/** One source field mapping is shared by the CPU mutators and the GPU synchronizers. */
function thinScope(
    context: LoweringContext,
    file: ts.SourceFile,
    gpu: boolean,
    parameters: ReadonlySet<string>,
): PinnedNumericScope {
    const bindings = new Map<string, PinnedBinding>();
    const bind = (
        name: string,
        cpp: string,
        type: PinnedBinding["type"] = "opaque",
        absentCpp?: string,
    ) =>
        bindings.set(name, {
            cpp,
            type,
            ...(absentCpp === undefined ? {} : { absentCpp }),
        });
    const bindArray = (
        name: string,
        cpp: string,
        kind: "f32" | "u32" | "f64-buffer",
        absentCpp?: string,
    ) => {
        bindings.set(name, {
            cpp,
            type: kind,
            mutable: true,
            indexedRead: (owner, index) =>
                `bbl::js::number_at(${owner}, ${index})`,
            indexedStore: (owner, index, value) =>
                `bbl::js::typed_array_write(${owner}, ${index}, ${value})`,
            ...(absentCpp === undefined ? {} : { absentCpp }),
        });
        bind(`${name}.buffer`, `${cpp}.buffer()`);
        bind(
            `${name}.byteOffset`,
            `static_cast<double>(${cpp}.byte_offset())`,
            "scalar",
        );
        bind(
            `${name}.byteLength`,
            `static_cast<double>(${cpp}.byte_length())`,
            "scalar",
        );
    };
    const roots: readonly (readonly [string, string])[] = gpu
        ? [["ti", "ti."]]
        : [
              [
                  "mesh.thinInstances",
                  "thin_instance_data(record.thin_instances).",
              ],
              ["ti", "thin_instance_data(ti)."],
          ];
    if (!gpu) {
        bind(
            "mesh.thinInstances",
            "record.thin_instances",
            "opaque",
            "!record.thin_instances",
        );
        bind("ti", "ti", "opaque", "!ti");
        bind(
            "mesh._runtimeThinBuild",
            "record.source_runtime_thin_builder",
            "bool",
        );
        bind("buildRuntimeThinMesh", "true", "bool");
    } else bind("ti", "ti");
    for (const [source, owner] of roots) {
        for (const [name, field] of Object.entries(fields)) {
            const cpp = `${owner}${field}`;
            const array = optionalArrays.get(name);
            if (array)
                bindArray(
                    `${source}.${name}`,
                    `${cpp}.value()`,
                    array,
                    `!${cpp}.has_value()`,
                );
            else if (
                ["_gpuBuffer", "_colorGpuBuffer", "_drawArgsBuffer"].includes(
                    name,
                )
            ) {
                bind(`${source}.${name}`, cpp, "opaque", `!${cpp}`);
                bind(`${source}.${name}.size`, `${cpp}->size`, "scalar");
            } else if (name === "matrices") {
                bind(`${source}.${name}`, cpp);
                bind(
                    `${source}.${name}.length`,
                    `std::visit([](const auto& view) { return static_cast<double>(view.size()); }, ${cpp})`,
                    "scalar",
                );
                bind(
                    `${source}.${name}.buffer`,
                    `std::get<js::F32Array>(${cpp}).buffer()`,
                );
                bind(
                    `${source}.${name}.byteOffset`,
                    `static_cast<double>(std::get<js::F32Array>(${cpp}).byte_offset())`,
                    "scalar",
                );
            } else
                bind(
                    `${source}.${name}`,
                    cpp,
                    name === "_gpuCullingEnabled" ||
                        name === "_colorGpuBufferStorage"
                        ? "bool"
                        : "scalar",
                );
        }
    }
    bind("device", "device");
    bind("engine", "engine");
    bind("engine._device", "device");
    bind("gpu", "geometry");
    bind("gpu.indexCount", "geometry.index_count", "scalar");
    bindings.set("gpu._baseVertex", {
        cpp: "geometry.base_vertex.value()",
        type: "scalar",
        nullish: "!geometry.base_vertex.has_value()",
    });
    bindings.set("gpu._firstIndex", absentDrawRangeBinding(context));
    for (const name of [
        "count",
        "index",
        "pad",
        "r",
        "g",
        "b",
        "a",
        "instanceCount",
    ])
        if (parameters.has(name))
            bind(
                name,
                name === "instanceCount" ? "instance_count" : name,
                "scalar",
            );
    bind("hasColor", "has_color", "bool");
    bind("enabled", "enabled", "bool");
    if (!gpu) {
        bind("matrices", "matrices");
        bind("matrix", "matrix", "f64-buffer");
        bindArray("colors", "colors", "f32");
    }
    bindArray("args", "args", "u32");
    for (const [flag, value] of Object.entries(
        webgpuFlagNamespaces.GPUBufferUsage!,
    ))
        bind(`BU.${flag}`, `${value}.0`, "scalar");
    const optionalTarget = (node: ts.Expression): string | undefined => {
        if (!ts.isPropertyAccessExpression(node)) return undefined;
        const root = roots.find(([source]) =>
            sameSource(node.expression, source),
        );
        const field = fields[node.name.text as keyof typeof fields];
        return root &&
            field &&
            (optionalArrays.has(node.name.text) ||
                node.name.text === "_drawArgsInstanceCount")
            ? `${root[1]}${field}`
            : undefined;
    };
    const calls = new Map<string, (args: readonly string[]) => string>([
        ["Number.isInteger", (args) => `js::number_is_integer(${args[0]})`],
        ["bumpVisibilityEpoch", () => "(++engine.draw_list_epoch)"],
        [
            "syncThinInstanceGpuData",
            (args) => `sync_thin_instance_gpu_data(${args.join(", ")}, device)`,
        ],
        [
            "syncThinInstanceDrawArgs",
            (args) =>
                `sync_thin_instance_draw_args(${args.join(", ")}, device)`,
        ],
        [
            "writeMeshIndexedIndirectArgs",
            (args) => `write_thin_indexed_indirect_args(${args.join(", ")})`,
        ],
        [
            "packMat4IntoF32",
            (args) => `pack_thin_matrix_into_f32(${args.join(", ")})`,
        ],
    ]);
    for (const prefix of ["device", "engine._device"]) {
        calls.set(
            `${prefix}.createBuffer`,
            (args) => `device.create_buffer(${args.join(", ")})`,
        );
        calls.set(
            `${prefix}.queue.writeBuffer`,
            (args) => `device.write_buffer(${args.join(", ")})`,
        );
    }
    return {
        bindings,
        calls,
        foldConditions: false,
        loopVariableType: "scalar",
        methods: new Map([
            [
                "set",
                (receiver, args) =>
                    `thin_instance_array_set(${receiver}, ${args[0]}, ${args[1] ?? "0.0"})`,
            ],
            [
                "copyWithin",
                (receiver, args) =>
                    `thin_instance_array_copy_within(${receiver}, ${args.join(", ")})`,
            ],
        ]),
        expression(node, lowerer) {
            if (node.kind === ts.SyntaxKind.NullKeyword) return "nullptr";
            if (ts.isPropertyAccessExpression(node)) {
                const method = arrayProperties.get(node.name.text);
                if (method) {
                    const matrix =
                        ts.isPropertyAccessExpression(node.expression) &&
                        node.expression.name.text === "matrices";
                    const value = lowerer.expression(node.expression);
                    const owner = matrix
                        ? `std::get<js::F32Array>(${value})`
                        : value;
                    return node.name.text === "buffer"
                        ? `${owner}.${method}`
                        : `static_cast<double>(${owner}.${method})`;
                }
            }
            if (
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword
            ) {
                context.assertExpressionShape(
                    node.right,
                    "F32",
                    "Thin-instance matrix storage brand",
                );
                return `std::holds_alternative<js::F32Array>(${lowerer.expression(node.left)})`;
            }
            if (
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind ===
                    ts.SyntaxKind.QuestionQuestionEqualsToken
            ) {
                const target = optionalTarget(node.left);
                if (!target)
                    return context.contractError(
                        node,
                        "Unrepresented optional thin-instance store.",
                    );
                return `pal::gpu_ensure(${target}, [&]() { return ${lowerer.expression(node.right)}; }).value()`;
            }
            if (
                ts.isNewExpression(node) &&
                ts.isIdentifier(node.expression) &&
                ["F32", "U32"].includes(node.expression.text) &&
                node.arguments?.length === 1
            )
                return `js::${node.expression.text.toLowerCase()}_array_sized(${lowerer.expression(node.arguments[0]!)})`;
            if (ts.isObjectLiteralExpression(node)) {
                const buffer = node.properties.some(
                    (property) =>
                        ts.isPropertyAssignment(property) &&
                        sameSource(property.name, "usage"),
                );
                const literal = pinnedRecordLiteral(
                    context,
                    lowerer,
                    node,
                    pinnedRecordSchema(
                        buffer ? "GpuBufferDescriptor" : "ThinInstancePoolData",
                        buffer
                            ? { label: "label", size: "size", usage: "usage" }
                            : fields,
                    ),
                    "value",
                );
                return buffer
                    ? literal
                    : `std::make_shared<ThinInstancePoolData>(${literal})`;
            }
            return undefined;
        },
        statement(node, lowerer, indent) {
            if (
                ts.isVariableStatement(node) &&
                node.declarationList.declarations.length === 1
            ) {
                const declaration = node.declarationList.declarations[0]!;
                const value = declaration.initializer;
                if (ts.isIdentifier(declaration.name) && value) {
                    const name = declaration.name.text;
                    if (name === "ti" && !gpu) {
                        context.assertExpressionShape(
                            value,
                            "mesh.thinInstances",
                            "Thin-instance pool owner",
                        );
                        return [`${indent}auto ti = record.thin_instances;`];
                    }
                    if (name === "retiredMatrix" || name === "retiredColor") {
                        lowerer.bindPorts(
                            [
                                [
                                    name,
                                    {
                                        cpp: name,
                                        type: "opaque",
                                        absentCpp: `!${name}`,
                                    },
                                ],
                            ],
                            declaration,
                        );
                        return [
                            `${indent}GpuHandle ${name} = ${lowerer.expression(value)};`,
                        ];
                    }
                    if (ts.isNewExpression(unwrapExpression(value))) {
                        const allocation = unwrapExpression(value);
                        if (
                            !ts.isNewExpression(allocation) ||
                            !ts.isIdentifier(allocation.expression) ||
                            allocation.expression.text !== "F32"
                        )
                            return context.contractError(
                                allocation,
                                "Unrepresented thin-instance array allocation.",
                            );
                        lowerer.bindPorts(
                            [[name, { cpp: name, type: "f32", mutable: true }]],
                            declaration,
                        );
                        return [
                            `${indent}auto ${name} = ${lowerer.expression(value)};`,
                        ];
                    }
                    if (name === "args") {
                        context.assertExpressionShape(
                            value,
                            "ti._drawArgsData!",
                            "Thin-instance indirect argument owner",
                        );
                        return [
                            `${indent}auto args = ti.draw_args_data.value();`,
                        ];
                    }
                }
            }
            if (ts.isExpressionStatement(node)) {
                const expression = unwrapExpression(node.expression);
                if (
                    ts.isBinaryExpression(expression) &&
                    expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
                ) {
                    const target = optionalTarget(expression.left);
                    if (target)
                        return [
                            `${indent}${target} = ${lowerer.expression(expression.right)};`,
                        ];
                }
                if (
                    ts.isCallExpression(expression) &&
                    sameSource(expression.expression, "retireGpuResources")
                ) {
                    const callback = expression.arguments[1];
                    if (
                        expression.arguments.length !== 2 ||
                        !callback ||
                        !ts.isArrowFunction(callback) ||
                        !ts.isBlock(callback.body)
                    )
                        return context.contractError(
                            expression,
                            "Expected thin-instance resource retirement callback.",
                        );
                    const body = lowerPinnedBody(
                        file,
                        callback.body.statements,
                        {
                            bindings: new Map(),
                            calls: new Map(),
                            statement(n, _l, i) {
                                if (
                                    ts.isExpressionStatement(n) &&
                                    ts.isCallExpression(n.expression) &&
                                    ts.isPropertyAccessExpression(
                                        n.expression.expression,
                                    ) &&
                                    n.expression.expression.questionDotToken &&
                                    n.expression.expression.name.text ===
                                        "destroy"
                                ) {
                                    const owner =
                                        n.expression.expression.expression.getText(
                                            file,
                                        );
                                    if (
                                        owner !== "retiredMatrix" &&
                                        owner !== "retiredColor"
                                    )
                                        return context.contractError(
                                            n,
                                            "Unrepresented retired thin-instance owner.",
                                        );
                                    return [
                                        `${i}if (${owner}) ${owner}->destroy();`,
                                    ];
                                }
                                return undefined;
                            },
                        },
                        indent + "    ",
                    );
                    return [
                        `${indent}retire_gpu_resources(pal::gpu_retirement_state(engine), [retiredMatrix, retiredColor]() {`,
                        body,
                        `${indent}});`,
                    ];
                }
            }
            return undefined;
        },
    };
}

function lowerFunction(
    context: LoweringContext,
    module: string,
    name: string,
    signature: string,
    returns = false,
): string {
    const { file, declaration } = context.functionDeclaration(module, name);
    const gpu = module !== cpuModule;
    const body = lowerPinnedBody(file, declaration.body!.statements, {
        ...thinScope(
            context,
            file,
            gpu,
            new Set(
                declaration.parameters.map((parameter) =>
                    soleBindingName(parameter.name),
                ),
            ),
        ),
        ...(returns
            ? {
                  returnValue: (
                      node: ts.Expression | undefined,
                      lowerer: import("./pinned-numeric-lowerer.js").PinnedNumericLowerer,
                  ) =>
                      node
                          ? lowerer.expression(node)
                          : context.contractError(
                                declaration,
                                "Expected a thin-instance return value.",
                            ),
              }
            : {}),
    });
    return `// ${context.provenance(module, name)}
${signature} {
${gpu ? "" : `    auto& record = ${recordAt("engine.meshes", "mesh")};\n`}${body}
}
`;
}

/** Complete pinned CPU bodies over the canonical shared pool. */
export function lowerThinInstanceApi(
    context: LoweringContext,
    features: readonly string[],
): string {
    const methods: [string, string, boolean?][] = [
        [
            "setThinInstances",
            "void set_thin_instances(Engine& engine, MeshHandle mesh, const ThinInstanceMatrices& matrices, double count)",
        ],
        [
            "setThinInstanceCount",
            "void set_thin_instance_count(Engine& engine, MeshHandle mesh, double count)",
        ],
        [
            "setThinInstanceMatrix",
            "void set_thin_instance_matrix(Engine& engine, MeshHandle mesh, double index, const js::NumericArrayView& matrix)",
        ],
        [
            "flushThinInstances",
            "void flush_thin_instances(Engine& engine, MeshHandle mesh)",
        ],
        [
            "setThinInstanceCullBoundsPad",
            "void set_thin_instance_cull_bounds_pad(Engine& engine, MeshHandle mesh, double pad)",
        ],
    ];
    if (features.includes("mesh:thin-instances-dynamic"))
        methods.push(
            [
                "addThinInstance",
                "double add_thin_instance(Engine& engine, MeshHandle mesh, const js::NumericArrayView& matrix)",
                true,
            ],
            [
                "removeThinInstance",
                "void remove_thin_instance(Engine& engine, MeshHandle mesh, double index)",
            ],
            [
                "setThinInstanceDrawCount",
                "void set_thin_instance_draw_count(Engine& engine, MeshHandle mesh, double count)",
            ],
            [
                "enableThinInstanceDynamicDrawCount",
                "void enable_thin_instance_dynamic_draw_count(Engine& engine, MeshHandle mesh)",
            ],
        );
    if (features.includes("mesh:thin-instance-colors"))
        methods.push(
            [
                "setThinInstanceColors",
                "void set_thin_instance_colors(Engine& engine, MeshHandle mesh, const js::F32Array& colors)",
            ],
            [
                "setThinInstanceColor",
                "void set_thin_instance_color(Engine& engine, MeshHandle mesh, double index, double r, double g, double b, double a)",
            ],
        );
    if (features.includes("mesh:thin-instance-gpu-culling"))
        methods.push([
            "enableThinInstanceGpuCulling",
            "void enable_thin_instance_gpu_culling(Engine& engine, MeshHandle mesh, bool enabled)",
        ]);
    return (
        methods
            .map(([name, signature, returns]) =>
                lowerFunction(context, cpuModule, name, signature, returns),
            )
            .join("\n") +
        `
ThinInstanceMatrices thin_instance_matrices(Engine& engine, MeshHandle mesh) {
    const auto& record = ${recordAt("engine.meshes", "mesh")};
    if (!record.thin_instances) throw js::NamedError("TypeError", "Thin-instance matrix storage is absent.");
    return record.thin_instances->matrices;
}
ThinInstanceMatrices thin_instance_matrices(const std::shared_ptr<ThinInstancePoolData>& pool) {
    return thin_instance_data(pool).matrices;
}
double thin_instance_count(const std::shared_ptr<ThinInstancePoolData>& pool) {
    return thin_instance_data(pool).count;
}
double thin_instance_count(const Engine& engine, MeshHandle mesh) {
    const auto& record = ${recordAt("engine.meshes", "mesh")};
    if (!record.thin_instances) throw js::NamedError("TypeError", "Thin-instance pool is absent.");
    return record.thin_instances->count;
}
`
    );
}

/** GPU allocation, active upload ranges, acknowledgment and argument promotion all come from the pin. */
export function lowerThinInstanceSync(context: LoweringContext): string {
    const packModule = "src/math/pack-mat4-into-f32.ts";
    const pack = context.functionDeclaration(packModule, "packMat4IntoF32");
    const packBody = lowerPinnedBody(
        pack.file,
        pack.declaration.body!.statements,
        {
            bindings: new Map<string, PinnedBinding>([
                [
                    "view",
                    {
                        cpp: "view",
                        type: "f32",
                        mutable: true,
                        indexedStore: (owner, index, value) =>
                            `js::typed_array_write(${owner}, ${index}, ${value})`,
                    },
                ],
                [
                    "mat",
                    {
                        cpp: "mat",
                        type: "f64-buffer",
                        indexedRead: (owner, index) =>
                            `js::number_at(${owner}, ${index})`,
                    },
                ],
                ["offsetFloats", { cpp: "offset", type: "scalar" }],
                ["srcOffsetFloats", { cpp: "source_offset", type: "scalar" }],
            ]),
            calls: new Map(),
            methods: new Map([
                [
                    "set",
                    (receiver, args) =>
                        `thin_instance_array_set(${receiver}, ${args.join(", ")})`,
                ],
            ]),
        },
    );
    const indirectModule = "src/mesh/mesh-indexed-indirect.ts";
    return `// ${context.provenance(packModule, "packMat4IntoF32")}
static void pack_thin_matrix_into_f32(js::F32Array view, const ThinInstanceMatrices& matrices, double offset, double source_offset) {
    std::visit([&](const auto& mat) {
${packBody}
    }, matrices);
}

${lowerFunction(context, indirectModule, "writeMeshIndexedIndirectArgs", "static void write_thin_indexed_indirect_args(js::U32Array args, const ThinInstanceGeometry& geometry, double instance_count)")}
${lowerFunction(context, gpuModule, "syncThinInstanceGpuData", "bool sync_thin_instance_gpu_data(Engine& engine, ThinInstancePoolData& ti, bool has_color, GpuDevice& device)", true)}
${lowerFunction(context, gpuModule, "syncThinInstanceDrawArgs", "GpuHandle sync_thin_instance_draw_args(Engine& engine, ThinInstancePoolData& ti, const ThinInstanceGeometry& geometry, GpuDevice& device)", true)}
${lowerFunction(context, gpuModule, "syncThinInstanceForDraw", "GpuHandle sync_thin_instance_for_draw(Engine& engine, ThinInstancePoolData& ti, bool has_color, const ThinInstanceGeometry& geometry, GpuDevice& device)", true)}
`;
}

/** Shared ownership is native; the pin's disposal count remains source state. */
export function lowerThinInstanceOwnership(context: LoweringContext): string {
    const module = "src/resource/ref-count.ts";
    return (["retain", "release"] as const)
        .map((name) => {
            const { file, declaration } = context.functionDeclaration(
                module,
                name,
            );
            const body = lowerPinnedBody(file, declaration.body!.statements, {
                bindings: new Map<string, PinnedBinding>([
                    [
                        "resource._refCount",
                        {
                            cpp: "state.ref_count.value()",
                            type: "scalar",
                            nullish: "!state.ref_count.has_value()",
                        },
                    ],
                    [
                        "count",
                        {
                            cpp: "count.value()",
                            type: "scalar",
                            absentCpp: "!count.has_value()",
                        },
                    ],
                ]),
                calls: new Map(),
                foldConditions: false,
                statement(node, lowerer, indent) {
                    if (ts.isVariableStatement(node)) {
                        context.assertStatementShapes(
                            declaration.body!,
                            [node],
                            "const count = resource._refCount;",
                            "Thin-instance release count snapshot",
                        );
                        return [`${indent}const auto count = state.ref_count;`];
                    }
                    if (
                        ts.isExpressionStatement(node) &&
                        ts.isBinaryExpression(node.expression) &&
                        node.expression.operatorToken.kind ===
                            ts.SyntaxKind.EqualsToken
                    ) {
                        context.assertExpressionShape(
                            node.expression.left,
                            "resource._refCount",
                            "Thin-instance reference count store",
                        );
                        return [
                            `${indent}state.ref_count = ${lowerer.expression(node.expression.right)};`,
                        ];
                    }
                    return undefined;
                },
                returnValue: (node, lowerer) =>
                    node ? lowerer.expression(node) : "",
            });
            return `// ${context.provenance(module, name)}
inline ${name === "retain" ? "void" : "bool"} ${name}_thin_instance_pool(const std::shared_ptr<ThinInstancePoolData>& resource) {
    auto& state = thin_instance_data(resource);
${body}
}`;
        })
        .join("\n\n");
}

/** LOD pairing is unrepresented; its absent source fields still constrain disposal. */
function lowerUnpairedThinInstanceDetach(context: LoweringContext): string {
    const { file, declaration } = context.functionDeclaration(
        cpuModule,
        "_detachThinInstanceLodMesh",
    );
    context.assertStatementShapes(
        declaration.body!,
        declaration.body!.statements,
        `
        const ti = mesh.thinInstances;
        if (!ti) { return; }
        const source = ti._lodSource;
        const sourceTi = source?.thinInstances;
        if (source && sourceTi?._lodPartner === mesh) {
            sourceTi._lodPartner = null;
            sourceTi._lodDistance = undefined;
            sourceTi._lodBand = undefined;
            sourceTi._lodBuckets = null;
            source._clone = undefined;
        }
        if (ti._lodSource) { releaseLodConsumer(ti); }
        const partner = ti._lodPartner;
        const partnerTi = partner?.thinInstances;
        ti._lodPartner = null;
        ti._lodDistance = undefined;
        ti._lodBand = undefined;
        ti._lodBuckets = null;
        mesh._clone = undefined;
        if (partner && partnerTi?._lodSource === mesh) {
            partner._clone = undefined;
            releaseLodConsumer(partnerTi);
        }
    `,
        "Unpaired thin-instance LOD disposal specialization",
    );
    const bindings = new Map<string, PinnedBinding>([
        [
            "mesh.thinInstances",
            { cpp: "pool", type: "opaque", absentCpp: "!pool" },
        ],
        ["ti", { cpp: "pool", type: "opaque", absentCpp: "!pool" }],
        ...[
            "source",
            "sourceTi",
            "partner",
            "partnerTi",
            "ti._lodSource",
            "ti._lodPartner",
        ].map((name) => [name, absentBinding()] as const),
    ]);
    const absentStores = new Set([
        "ti._lodPartner",
        "ti._lodDistance",
        "ti._lodBand",
        "ti._lodBuckets",
        "mesh._clone",
    ]);
    const body = lowerPinnedBody(file, declaration.body!.statements, {
        bindings,
        calls: new Map(),
        statement(node) {
            if (
                ts.isExpressionStatement(node) &&
                ts.isBinaryExpression(node.expression) &&
                node.expression.operatorToken.kind ===
                    ts.SyntaxKind.EqualsToken &&
                isOneOfSources(node.expression.left, absentStores)
            )
                return [];
            return undefined;
        },
    });
    return `// ${context.provenance(cpuModule, "_detachThinInstanceLodMesh", "unpaired ownership")}
static void detach_unpaired_thin_instance_pool(const std::shared_ptr<ThinInstancePoolData>& pool) {
${body}
}`;
}

/** The whole thin-pool disposal subtree; the enclosing mesh guard owns repeat calls. */
export function lowerThinInstanceDisposal(context: LoweringContext): string {
    const module = "src/mesh/mesh-dispose.ts";
    const { file, declaration } = context.functionDeclaration(
        module,
        "disposeMeshGpu",
    );
    const start = declaration.body!.statements.findIndex(
        (statement) =>
            ts.isVariableStatement(statement) &&
            statement.declarationList.declarations.some(
                (local) =>
                    ts.isIdentifier(local.name) && local.name.text === "ti",
            ),
    );
    if (start < 0)
        return context.contractError(
            declaration,
            "Expected thin-instance disposal owner.",
        );
    const statements = declaration.body!.statements.slice(start, start + 2);
    context.assertStatementShapes(
        declaration.body!,
        statements,
        `
        const ti = mesh.thinInstances;
        if(ti && release(ti)) {
            _detachThinInstanceLodMesh(mesh);
            ti._gpuBuffer?.destroy();
            ti._colorGpuBuffer?.destroy();
            ti._drawArgsBuffer?.destroy();
        }
    `,
        "Thin-instance disposal subtree",
    );
    const body = lowerPinnedBody(file, statements, {
        bindings: new Map<string, PinnedBinding>([
            ["mesh", { cpp: "pool", type: "opaque" }],
            [
                "mesh.thinInstances",
                { cpp: "pool", type: "opaque", absentCpp: "!pool" },
            ],
            ["ti", { cpp: "pool", type: "opaque", absentCpp: "!pool" }],
        ]),
        calls: new Map([
            [
                "release",
                (args: readonly string[]) =>
                    `release_thin_instance_pool(${args.join(",")})`,
            ],
            [
                "_detachThinInstanceLodMesh",
                () => "detach_unpaired_thin_instance_pool(pool)",
            ],
        ]),
        callShapes: new Map([["release", "bool"]]),
        expression(node) {
            if (
                ts.isCallExpression(node) &&
                ts.isPropertyAccessExpression(node.expression) &&
                node.questionDotToken === undefined &&
                node.expression.questionDotToken &&
                node.expression.name.text === "destroy"
            ) {
                const receiver = node.expression.expression;
                if (!ts.isPropertyAccessExpression(receiver))
                    return context.contractError(
                        node,
                        "Expected a thin GPU owner.",
                    );
                const field = fields[receiver.name.text as keyof typeof fields];
                if (!field)
                    return context.contractError(
                        receiver,
                        "Unrepresented thin GPU owner.",
                    );
                return `(pool->${field} ? pool->${field}->destroy() : void())`;
            }
            return undefined;
        },
    });
    return `${lowerUnpairedThinInstanceDetach(context)}
// ${context.provenance(module, "disposeMeshGpu", "thin-instance ownership subtree")}
void dispose_thin_instance_gpu(const std::shared_ptr<ThinInstancePoolData>& pool) {
${body}
}`;
}

/** Always emitted: clone-only scenes also retain their represented resource fields. */
export function thinInstanceHeader(context: LoweringContext): string {
    return `#pragma once
#include <bblite/thin_instance.hpp>
namespace bbl {
struct Engine;
struct GpuDevice;
${lowerThinInstanceOwnership(context)}
void dispose_thin_instance_gpu(const std::shared_ptr<ThinInstancePoolData>&);
bool sync_thin_instance_gpu_data(Engine&, ThinInstancePoolData&, bool, GpuDevice&);
GpuHandle sync_thin_instance_draw_args(Engine&, ThinInstancePoolData&, const ThinInstanceGeometry&, GpuDevice&);
GpuHandle sync_thin_instance_for_draw(Engine&, ThinInstancePoolData&, bool, const ThinInstanceGeometry&, GpuDevice&);
}
`;
}
