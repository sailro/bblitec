import ts from "typescript";
import { stringLiteral } from "../cpp-literals.js";
import {
    type LoweringContext,
    type LoweredSource,
    unwrapExpression,
} from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import {
    type PinnedBinding,
    type PinnedNumericScope,
} from "./pinned-numeric-lowerer.js";
import {
    pinnedRecordLiteral,
    pinnedRecordSchema,
    type PinnedRecordSchema,
} from "./pinned-record-literal.js";

const path = "src/compute/compute-bindings.ts";
const fields: Record<string, string> = {
    shader: "shader",
    _shader: "shader",
    _entries: "entries",
    _volatileEntries: "volatile_entries",
    _dynamicSlots: "dynamic_slots",
    _zeroDynamicOffsets: "zero_dynamic_offsets",
    _device: "device",
    _groups: "groups",
    _resourceEpoch: "resource_epoch",
    _destroyed: "destroyed",
};
const setSchema = pinnedRecordSchema("ComputeBindingSet", fields);
const entrySchema = pinnedRecordSchema("ResolvedComputeBinding", {
    _decl: "decl",
    _resolver: "resolver",
    _state: "state",
});
const slotSchema = pinnedRecordSchema("ComputeDynamicBindingSlot", {
    _group: "group",
    _index: "index",
    _alignment: "alignment",
    _maxOffset: "max_offset",
});
const gpuEntrySchema: PinnedRecordSchema = {
    cpp: "pal::ComputeBindGroupEntry",
    fields: {
        binding: {
            cpp: "binding",
            convert: (cpp) => `static_cast<std::uint32_t>(${cpp})`,
        },
        resource: { cpp: "resource" },
    },
};
const groupSchema = pinnedRecordSchema("pal::ComputeBindGroupDescriptor", {
    label: "label",
    layout: "layout",
    entries: "entries",
});

function scope(
    context: LoweringContext,
    file: ts.SourceFile,
    creating: boolean,
): PinnedNumericScope {
    const bindings = new Map<string, PinnedBinding>();
    for (const name of [
        "bindings",
        "shader",
        "resources",
        "decl",
        "entries",
        "resolver",
        "resolved",
        "entry",
        "input",
        "slot",
        "layouts",
        "groups",
        "dynamicSlots",
        "volatileEntries",
    ])
        bindings.set(name, { cpp: name, type: "opaque" });
    bindings.set("validateVolatile", { cpp: "validateVolatile", type: "bool" });
    for (const [source, cpp] of Object.entries(fields))
        bindings.set(`bindings.${source}`, {
            cpp: `bindings->${cpp}`,
            type:
                source === "_destroyed"
                    ? "bool"
                    : source === "_resourceEpoch"
                      ? "scalar"
                      : "opaque",
        });
    const properties: Record<string, [string, PinnedBinding["type"]]> = {
        "bindings.shader.name": ["bindings->shader->name", "opaque"],
        "shader.name": ["shader->name", "opaque"],
        "shader._engine": ["shader->engine", "opaque"],
        "shader._engine._device": [
            "std::shared_ptr<pal::OffscreenDevice>(shader->engine->offscreen_run, &shader->engine->offscreen_run->device())",
            "opaque",
        ],
        "decl.name": ["decl->name", "opaque"],
        "decl.group": ["decl->group", "scalar"],
        "decl._kind": ["decl->kind", "scalar"],
        "resolved._state": ["resolved.state", "opaque"],
        "resolved._dynamic": ["resolved.dynamic", "opaque"],
        "resolved._dynamic._alignment": [
            "resolved.dynamic->alignment",
            "scalar",
        ],
        "resolved._dynamic._maxOffset": [
            "resolved.dynamic->max_offset",
            "scalar",
        ],
        "resolver._validate": ["resolver->validate", "opaque"],
        "slot._dynamicIndex": ["slot.dynamic_index", "scalar"],
        "entry._state": ["entry.state", "opaque"],
        "entry._decl.group": ["entry.decl->group", "scalar"],
        "entry._decl.binding": ["entry.decl->binding", "scalar"],
        "volatileEntries.length": [
            "static_cast<double>(volatileEntries->size())",
            "scalar",
        ],
        "layouts.length": ["static_cast<double>(layouts->size())", "scalar"],
        "bindings._entries.length": [
            "static_cast<double>(bindings->entries.size())",
            "scalar",
        ],
    };
    for (const [name, [cpp, type]] of Object.entries(properties))
        bindings.set(name, { cpp, type });
    const calls = new Map<string, (args: readonly string[]) => string>([
        [
            "_assertComputeShaderLive",
            (args) => `assert_compute_shader_live(${args.join(", ")})`,
        ],
        [
            "_getComputeGroupLayouts",
            (args) => `get_compute_group_layouts(${args.join(", ")})`,
        ],
        [
            "_getComputeBindingResolver",
            (args) => `get_compute_binding_resolver(${args.join(", ")})`,
        ],
        [
            "_ensureComputeBindingGroups",
            (args) => `ensure_compute_binding_groups(${args.join(", ")})`,
        ],
        [
            "shader._slots.has",
            (args) => `shader->slots.contains(${args.join(", ")})`,
        ],
        ["shader._slots.get", (args) => `shader->slots.at(${args.join(", ")})`],
        ["Object.hasOwn", (args) => `${args[0]}.contains(${args[1]})`],
        [
            "resolver._resolve",
            (args) => `resolver->resolve(${args.join(", ")})`,
        ],
        [
            "entry._resolver._get",
            (args) => `entry.resolver->get(${args.join(", ")})`,
        ],
        [
            "entry._resolver._validate!",
            (args) => `entry.resolver->validate(${args.join(", ")})`,
        ],
        ["groups.push", (args) => `groups->push_back(${args.join(", ")})`],
    ]);
    return {
        bindings,
        calls,

        foldConditions: false,
        callShapes: new Map([
            ["shader._slots.has", "bool"],
            ["Object.hasOwn", "bool"],
        ]),
        expression(node, l) {
            if (
                ts.isCallExpression(node) &&
                unwrapExpression(node.expression).getText(file) ===
                    "entry._resolver._validate"
            )
                return `entry.resolver->validate(${node.arguments.map((arg) => l.expression(arg)).join(", ")})`;
            if (ts.isStringLiteralLike(node))
                return `std::string{${stringLiteral(node.text)}}`;
            if (node.kind === ts.SyntaxKind.NullKeyword) return "nullptr";
            if (
                context.expressionMatchesShape(
                    node,
                    "shader._engine._resourceEpoch ?? 0",
                )
            )
                return "shader->engine->resource_epoch";
            if (ts.isTemplateExpression(node))
                return [
                    `std::string{${stringLiteral(node.head.text)}}`,
                    ...node.templateSpans.flatMap((span) => [
                        context.expressionMatchesShape(span.expression, "group")
                            ? `js::number_to_string(static_cast<double>(${l.expression(span.expression)}))`
                            : l.expression(span.expression),
                        `std::string{${stringLiteral(span.literal.text)}}`,
                    ]),
                ].join(" + ");
            if (ts.isElementAccessExpression(node)) {
                const owner = node.expression.getText(file),
                    index = l.expression(node.argumentExpression);
                if (owner === "resources") return `resources.at(${index})`;
                const collections: Record<string, string> = {
                    volatileEntries: "volatileEntries->",
                    layouts: "layouts->",
                    "bindings._entries": "bindings->entries.",
                };
                if (collections[owner])
                    return `${collections[owner]}at(static_cast<std::size_t>(${index}))`;
            }
            if (
                context.expressionMatchesShape(
                    node,
                    "validateVolatile ? bindings._volatileEntries : null",
                )
            )
                return "(validateVolatile && bindings->volatile_entries ? &*bindings->volatile_entries : nullptr)";
            if (
                context.expressionMatchesShape(
                    node,
                    "dynamicSlots ? shader._dynamicCounts.map((count) => new Array<number>(count).fill(0)) : null",
                )
            )
                return "([&]() -> std::optional<std::vector<std::vector<double>>> {if(!dynamicSlots)return std::nullopt;std::vector<std::vector<double>> offsets;for(double count:shader->dynamic_counts)offsets.emplace_back(static_cast<std::size_t>(count),0.0);return offsets;}())";
            if (
                ts.isCallExpression(node) &&
                node.expression.getText(file) ===
                    "shader._engine._device.createBindGroup"
            ) {
                if (node.arguments.length !== 1)
                    return context.contractError(
                        node,
                        "Expected compute bind group descriptor.",
                    );
                return `shader->engine->offscreen_run->device().create_compute_bind_group(${pinnedRecordLiteral(context, l, node.arguments[0]!, groupSchema)})`;
            }
            return undefined;
        },
        forOf(iterated, element) {
            if (iterated === "Object.keys(resources)")
                return {
                    range: "resources",
                    bindings: new Map([
                        [element, { cpp: `${element}.first`, type: "opaque" }],
                    ]),
                };
            if (iterated === "shader._decls")
                return {
                    range: "shader->decls",
                    bindings: new Map([
                        ...[...bindings].filter(([name]) =>
                            name.startsWith(`${element}.`),
                        ),
                        [element, { cpp: element, type: "opaque" }],
                    ]),
                };
            return undefined;
        },
        statement(node, l, indent) {
            if (
                ts.isVariableStatement(node) &&
                node.declarationList.declarations.length === 1
            ) {
                const declaration = node.declarationList.declarations[0]!;
                if (
                    !ts.isIdentifier(declaration.name) ||
                    !declaration.initializer
                )
                    return undefined;
                const name = declaration.name.text,
                    initial = unwrapExpression(declaration.initializer);
                if (name === "entries") {
                    context.assertExpressionShape(
                        initial,
                        "[]",
                        "Compute binding entries",
                    );
                    return [
                        `${indent}std::vector<${creating ? "ResolvedComputeBinding" : "pal::ComputeBindGroupEntry"}> entries;`,
                    ];
                }
                if (
                    name === "dynamicSlots" ||
                    (name === "volatileEntries" && creating)
                ) {
                    context.assertExpressionShape(
                        initial,
                        "null",
                        "Optional compute binding metadata",
                    );
                    return [
                        `${indent}std::optional<${name === "dynamicSlots" ? "ComputeDynamicBindingSlots" : "std::vector<ResolvedComputeBinding>"}> ${name};`,
                    ];
                }
                if (name === "groups") {
                    context.assertExpressionShape(
                        initial,
                        "[]",
                        "Compute bind group collection",
                    );
                    return [
                        `${indent}auto groups=std::make_shared<ComputeBindGroups>();`,
                    ];
                }
                if (name === "bindings")
                    return [
                        `${indent}auto bindings=js::make_gc_shared<ComputeBindingSet>(${pinnedRecordLiteral(context, l, initial, setSchema)});`,
                    ];
                if (name === "entry" && creating) {
                    l.bindPorts(
                        [...bindings].filter(
                            ([port]) =>
                                port === name || port.startsWith(`${name}.`),
                        ),
                        declaration,
                    );
                    return [
                        `${indent}auto entry=${pinnedRecordLiteral(context, l, initial, entrySchema)};`,
                    ];
                }
                if (
                    [
                        "input",
                        "resolver",
                        "resolved",
                        "slot",
                        "entry",
                        "shader",
                        "layouts",
                        "volatileEntries",
                    ].includes(name)
                ) {
                    l.bindPorts(
                        [...bindings].filter(
                            ([port]) =>
                                port === name || port.startsWith(`${name}.`),
                        ),
                        declaration,
                    );
                    return [
                        `${indent}const auto${name === "input" || name === "entry" ? "&" : ""} ${name}=${l.expression(initial)};`,
                    ];
                }
            }
            if (ts.isExpressionStatement(node)) {
                const expression = unwrapExpression(node.expression);
                if (ts.isCallExpression(expression)) {
                    const callee = expression.expression.getText(file);
                    if (callee === "entries.push") {
                        const value = expression.arguments[0];
                        if (!value || expression.arguments.length !== 1)
                            return context.contractError(
                                expression,
                                "Expected one compute entry.",
                            );
                        return [
                            `${indent}entries.push_back(${creating ? l.expression(value) : pinnedRecordLiteral(context, l, value, gpuEntrySchema)});`,
                        ];
                    }
                    if (ts.isPropertyAccessExpression(expression.expression)) {
                        const receiver = unwrapExpression(
                            expression.expression.expression,
                        );
                        if (
                            context.expressionMatchesShape(
                                receiver,
                                "volatileEntries ??= []",
                            ) &&
                            expression.expression.name.text === "push"
                        ) {
                            return [
                                `${indent}if(!volatileEntries)volatileEntries.emplace();`,
                                `${indent}volatileEntries->push_back(${l.expression(expression.arguments[0]!)});`,
                            ];
                        }
                        if (
                            context.expressionMatchesShape(
                                receiver,
                                "dynamicSlots ??= new Map()",
                            ) &&
                            expression.expression.name.text === "set"
                        ) {
                            return [
                                `${indent}if(!dynamicSlots)dynamicSlots.emplace();`,
                                `${indent}dynamicSlots->insert_or_assign(${l.expression(expression.arguments[0]!)},${pinnedRecordLiteral(context, l, expression.arguments[1]!, slotSchema)});`,
                            ];
                        }
                    }
                }
            }
            return undefined;
        },
    };
}

export function lowerComputeBindings(context: LoweringContext): LoweredSource {
    const methods = [
        [
            "createComputeBindingSet",
            "std::shared_ptr<ComputeBindingSet> create_compute_binding_set(const std::shared_ptr<ComputeShader>& shader,const ComputeBindingResources& resources)",
        ],
        [
            "_ensureComputeBindingGroups",
            "std::shared_ptr<ComputeBindGroups> ensure_compute_binding_groups(const std::shared_ptr<ComputeBindingSet>& bindings,bool validateVolatile)",
        ],
        [
            "disposeComputeBindingSet",
            "void dispose_compute_binding_set(const std::shared_ptr<ComputeBindingSet>& bindings)",
        ],
    ];
    const output = methods.map(([name, signature]) => {
        const { file, declaration } = context.functionDeclaration(path, name!);
        const body = lowerPinnedBody(file, declaration.body!.statements, {
            ...scope(context, file, name === "createComputeBindingSet"),
            returnValue: (node, l) => (node ? l.expression(node) : ""),
        });
        return `// ${context.provenance(path, name!)}\n${signature}{\n${body}\n}`;
    });
    return {
        modulePath: path,
        symbolName: "createComputeBindingSet",
        header: "",
        source: `#include <bblite/pal_compute_bindings.hpp>\nnamespace bbl {\n${output.join("\n")}\n}\n`,
    };
}
