import ts from "typescript";
import { stringLiteral } from "../cpp-literals.js";
import {
    type LoweredSource,
    type LoweringContext,
    unwrapExpression,
} from "./context.js";
import {
    lowerPinnedBody,
    type PinnedBodyScope,
} from "./pinned-body-lowerer.js";
import { type PinnedBinding } from "./pinned-numeric-lowerer.js";
import { pinnedRecordLiteral } from "./pinned-record-literal.js";

const helpers = [
    ["texture", "Texture", "ComputeTextureResource", "resource"],
    ["sampler", "Sampler", "ComputeSamplerResource", "sampler"],
    ["storage_texture", "StorageTexture", "ComputeStorageTexture", "resource"],
] as const;

function resolverScope(
    context: LoweringContext,
    file: ts.SourceFile,
    kind: (typeof helpers)[number][0],
    native: string,
    local: string,
): PinnedBodyScope {
    const bindings = new Map<string, PinnedBinding>();
    const property = (
        name: string,
        cpp: string,
        type: PinnedBinding["type"] = "opaque",
    ) => bindings.set(name, { cpp, type });
    for (const name of [
        "engine",
        "decl",
        "input",
        "state",
        "resource",
        "sampler",
        "data",
        "expected",
    ])
        property(name, name);
    property("decl.name", "decl->name");
    property(
        "decl._data",
        kind === "sampler" ? "decl->data.sampler_type" : "decl->data",
    );
    property(
        `${local}._engine`,
        kind === "storage_texture"
            ? "(resource->registry.lock() ? resource->registry.lock()->engine.lock() : nullptr)"
            : `${local}->engine.lock()`,
    );
    property(`${local}._destroyed`, `${local}->destroyed`, "bool");
    property("resource.texture.view", "resource->handle");
    property("sampler._sampler", "sampler->allocation");
    property("sampler.type", "sampler->type");
    property("resource.sampleType", "resource->sample_type");
    property("resource.multisampled", "resource->multisampled", "bool");
    property(
        "resource.viewDimension",
        kind === "storage_texture"
            ? "resource->descriptor.dimension"
            : "resource->view_dimension",
    );
    property("resource.format", "resource->descriptor.format");
    for (const [name, cpp] of Object.entries({
        sampleType: "sample_type",
        multisampled: "multisampled",
        viewDimension: "view_dimension",
        access: "access",
        format: "format",
    }))
        property(
            `data.${name}`,
            `data.${cpp}`,
            name === "multisampled" ? "bool" : "opaque",
        );
    const calls = new Map<string, (args: readonly string[]) => string>([
        [
            "_validateComputeTextureResource",
            (args) => `validate_compute_texture_resource(${args.join(", ")})`,
        ],
        [
            "_isComputeTextureSampleTypeCompatible",
            (args) =>
                `is_compute_texture_sample_type_compatible(${args.join(", ")})`,
        ],
        [
            "_hasComputeStorageTexture",
            () =>
                "(resource->registry.lock() && resource->registry.lock()->engine.lock() == engine && resource->registry.lock()->resources.contains(resource))",
        ],
        [
            "resource.accesses.includes",
            (args) =>
                `(std::find(resource->descriptor.accesses.begin(), resource->descriptor.accesses.end(), ${args[0]}) != resource->descriptor.accesses.end())`,
        ],
    ]);
    return {
        bindings,
        calls,
        booleanOr: true,
        booleanAnd: true,
        foldConditions: false,
        callShapes: new Map([
            ["_isComputeTextureSampleTypeCompatible", "bool"],
            ["_hasComputeStorageTexture", "bool"],
            ["resource.accesses.includes", "bool"],
        ]),
        expression(node) {
            if (ts.isStringLiteralLike(node))
                return `std::string{${stringLiteral(node.text)}}`;
            if (context.expressionMatchesShape(node, "resource.texture?.view"))
                return "resource->handle";
            return undefined;
        },
        statement(node, lowerer, indent) {
            if (
                !ts.isVariableStatement(node) ||
                node.declarationList.declarations.length !== 1
            )
                return undefined;
            const decl = node.declarationList.declarations[0]!;
            if (!ts.isIdentifier(decl.name) || !decl.initializer)
                return undefined;
            const name = decl.name.text;
            if (name === local) {
                const input = unwrapExpression(decl.initializer).getText(file);
                if (input !== "input" && input !== "state")
                    return context.contractError(
                        decl,
                        "Expected resolver input or retained state.",
                    );
                return [
                    `${indent}const auto ${local} = std::get_if<std::shared_ptr<${native}>>(&${input}) ? std::get<std::shared_ptr<${native}>>(${input}) : nullptr;`,
                ];
            }
            if (name === "data" || name === "expected")
                return [
                    `${indent}const auto& ${name} = ${lowerer.expression(decl.initializer)};`,
                ];
            return undefined;
        },
        returnValue(node, lowerer) {
            if (!node) return "";
            const value = unwrapExpression(node);
            if (ts.isObjectLiteralExpression(value))
                return pinnedRecordLiteral(context, lowerer, value, {
                    cpp: "ComputeResolvedBinding",
                    fields: { _state: { cpp: "state" } },
                });
            const fields: Record<string, [string, string]> = {
                "resource.texture.view": ["resource->handle", "sampled"],
                "sampler._sampler": ["sampler->allocation", "sampler"],
                "resource._view": ["resource->allocation", "storage"],
            };
            const projection = fields[value.getText(file)];
            if (projection)
                return `pal::ComputeTextureResource{${projection[0]},pal::ComputeTextureViewRole::${projection[1]}}`;
            return context.contractError(
                value,
                "Unrepresented compute binding resource.",
            );
        },
    };
}

function registrySource(context: LoweringContext): string {
    const path = "src/compute/compute-binding.ts";
    return ["_installComputeBindingResolver", "_getComputeBindingResolver"]
        .map((name) => {
            const { file, declaration } = context.functionDeclaration(
                path,
                name,
            );
            const install = name === "_installComputeBindingResolver";
            const body = lowerPinnedBody(file, declaration.body!.statements, {
                bindings: new Map<string, PinnedBinding>([
                    ["kind", { cpp: "kind", type: "scalar" }],
                    ["resolver", { cpp: "resolver", type: "opaque" }],
                ]),
                calls: new Map(),
                foldConditions: false,
                expression(node) {
                    if (
                        context.expressionMatchesShape(
                            node,
                            "_resolvers?.[kind]",
                        )
                    )
                        return "(js::realm_scratch<ComputeResolverRegistry>().values.contains(kind) ? js::realm_scratch<ComputeResolverRegistry>().values.at(kind) : nullptr)";
                    return undefined;
                },
                statement(node, lowerer, indent) {
                    if (
                        ts.isVariableStatement(node) &&
                        node.declarationList.declarations.length === 1
                    ) {
                        const decl = node.declarationList.declarations[0]!;
                        if (decl.name.getText(file) === "resolvers") {
                            context.assertExpressionShape(
                                decl.initializer!,
                                "(_resolvers ??= [])",
                                "Compute resolver registry allocation",
                            );
                            return [
                                `${indent}auto& resolvers = js::realm_scratch<ComputeResolverRegistry>().values;`,
                            ];
                        }
                        if (decl.name.getText(file) === "resolver")
                            return [
                                `${indent}const auto resolver = ${lowerer.expression(decl.initializer!)};`,
                            ];
                    }
                    if (
                        ts.isExpressionStatement(node) &&
                        context.expressionMatchesShape(
                            node.expression,
                            "resolvers[kind] ??= { _resolve: resolve, _get: get, _validate: validate }",
                        )
                    )
                        return [
                            `${indent}if (!resolvers.contains(kind)) resolvers.emplace(kind, std::make_shared<const ComputeBindingResolver>(ComputeBindingResolver{resolve,get,validate}));`,
                        ];
                    return undefined;
                },
                returnValue: (node, lowerer) =>
                    node ? lowerer.expression(node) : "",
            });
            return `// ${context.provenance(path, name)}\n${install ? "void install_compute_binding_resolver(double kind,ComputeBindingResolver::Resolve resolve,ComputeBindingResolver::Get get,ComputeBindingResolver::Validate validate)" : "std::shared_ptr<const ComputeBindingResolver> get_compute_binding_resolver(double kind)"}{\n${body}\n}`;
        })
        .join("\n");
}

export function lowerComputeBindingResolvers(
    context: LoweringContext,
): LoweredSource {
    const output: string[] = [registrySource(context)];
    const membership = context.functionDeclaration(
        "src/resource/compute-storage-texture.ts",
        "_hasComputeStorageTexture",
    ).declaration;
    context.assertStatementShapes(
        membership,
        membership.body!.statements,
        "return _resources?.get(engine)?.has(resource) === true;",
        "Compute storage texture membership",
    );
    for (const [kind, source, native, local] of helpers) {
        const path = `src/compute/compute-${kind.replaceAll("_", "-")}-binding.ts`;
        for (const verb of ["resolve", "get"]) {
            const name = `${verb}${source}`,
                { file, declaration } = context.functionDeclaration(path, name);
            const scope = resolverScope(context, file, kind, native, local);
            const body = lowerPinnedBody(
                file,
                declaration.body!.statements,
                scope,
            );
            output.push(
                `// ${context.provenance(path, name)}\n${verb === "resolve" ? `ComputeResolvedBinding resolve_compute_${kind}_input(const std::shared_ptr<Engine>& engine,const ComputeBindingDeclPtr& decl,const ComputeBindingInput& input)` : `pal::ComputeBindingResource get_compute_${kind}_input(const std::shared_ptr<Engine>& engine,const ComputeBindingState& state)`}{\n${body}\n}`,
            );
        }
        if (kind === "texture") {
            const { file, declaration } = context.functionDeclaration(
                path,
                "_computeTextureViewBinding",
            );
            const validate = context.callExpression(
                declaration,
                "_installComputeBindingResolver",
            ).arguments[3];
            if (
                !validate ||
                !ts.isArrowFunction(validate) ||
                !ts.isBlock(validate.body)
            )
                return context.contractError(
                    declaration,
                    "Expected sampled texture volatile validator.",
                );
            output.push(
                `void validate_compute_texture_binding(const std::shared_ptr<Engine>& engine,const ComputeBindingState& state){\n${lowerPinnedBody(file, validate.body.statements, resolverScope(context, file, kind, native, local))}\n}`,
            );
        }
    }
    for (const kind of ["storage", "uniform"]) {
        output.push(`ComputeResolvedBinding resolve_compute_${kind}_buffer_input(const std::shared_ptr<Engine>& engine,const ComputeBindingDeclPtr& decl,const ComputeBindingInput& input){
 const auto range = std::get_if<ComputeBufferRange>(&input);
 const auto value = resolve_compute_${kind}_buffer(engine,decl,range ? *range : ComputeBufferRange{});
 return {value.state,value.dynamic};
}
pal::ComputeBindingResource get_compute_${kind}_buffer_input(const std::shared_ptr<Engine>& engine,const ComputeBindingState& state){
 return get_compute_${kind}_buffer(engine,std::get<ComputeBufferBindingState>(state));
}`);
    }
    return {
        modulePath: "src/compute/compute-binding.ts",
        symbolName: "_getComputeBindingResolver",
        header: "",
        source: `#include <bblite/pal_compute_bindings.hpp>\n#include <bblite/pal_compute_storage_texture.hpp>\nnamespace bbl {\n${output.join("\n")}\n}\n`,
    };
}
