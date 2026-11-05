import ts from "typescript";
import { LoweringContext } from "../context.js";
import { lowerPinnedBody } from "../pinned-body-lowerer.js";
import type { PinnedBinding } from "../pinned-numeric-lowerer.js";
import { lowerGltfMaterialObjectFunction } from "./material-object-lowerer.js";
import { gpuSamplerDescriptorMembers } from "../gpu-schema.js";
import { pinnedSamplerKey } from "../sampler-pool.js";

const module = "src/loader-gltf/gltf-sampler-desc.ts";

/** The pin's sampler key (`sampler-pool.ts`), over a glTF descriptor value. */
function lowerSamplerKey(context: LoweringContext): string {
    return lowerGltfMaterialObjectFunction(
        context,
        {
            module: "src/resource/sampler-pool.ts",
            name: "samplerKey",
            sourceSymbol: "getOrCreateSampler",
            cpp: "gltf_source_sampler_key",
            declaration: pinnedSamplerKey(context).keyFunction,
        },
        () => undefined,
    );
}

export const gltfSamplerDeclarations = `class GltfPbrValue;
using GltfMaterialSampler = std::shared_ptr<const TextureSamplerState>;
struct GltfSamplerContext {
    std::shared_ptr<const GltfPbrValue> document;
    GltfMaterialSampler default_sampler;
    std::unordered_map<std::string, GltfMaterialSampler> cache;
    GltfSamplerContext(const JsonArray& textures, const JsonArray& samplers);
    explicit GltfSamplerContext(GltfMaterialSampler sampler) : default_sampler(std::move(sampler)) {}
    GltfMaterialSampler resolve(const ts::JsonValue* info);
};`;

/** Lower sampler creation and sharing decisions; allocation is an injected device boundary. */
function lowerSamplerFor(context: LoweringContext): string {
    const { file, declaration } = context.functionDeclaration(
        module,
        "makeSamplerFor",
    );
    const returned = declaration.body!.statements[0];
    const arrow =
        returned &&
        ts.isReturnStatement(returned) &&
        returned.expression &&
        context.unwrapExpression(returned.expression);
    if (
        declaration.body!.statements.length !== 1 ||
        !arrow ||
        !ts.isArrowFunction(arrow) ||
        !ts.isBlock(arrow.body) ||
        arrow.parameters.length !== 1 ||
        !ts.isIdentifier(arrow.parameters[0]!.name)
    )
        context.contractError(
            declaration,
            "Expected a returned sampler resolver.",
        );
    const info = arrow.parameters[0]!.name.text;
    const bindings = new Map<string, PinnedBinding>([
        [info, { cpp: "info", type: "opaque", absentCpp: "!info" }],
        [
            "defaultSampler",
            {
                cpp: "default_sampler",
                type: "opaque",
                absentCpp: "!default_sampler",
            },
        ],
    ]);
    const descriptors = new Set<string>();
    const body = lowerPinnedBody(file, arrow.body.statements, {
        bindings,
        calls: new Map(),
        foldConditions: false,
        expression(node, lowerer) {
            if (
                ts.isBinaryExpression(node) &&
                node.right.kind === ts.SyntaxKind.NullKeyword &&
                [
                    ts.SyntaxKind.EqualsEqualsToken,
                    ts.SyntaxKind.ExclamationEqualsToken,
                ].includes(node.operatorToken.kind)
            )
                return `(${lowerer.expression(node.left)} ${node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ? "==" : "!="} nullptr)`;
            if (
                ts.isPropertyAccessExpression(node) &&
                ts.isIdentifier(node.expression) &&
                descriptors.has(node.expression.text)
            )
                return `${node.expression.text}.get(${JSON.stringify(node.name.text)}).number()`;
            if (!ts.isCallExpression(node)) return undefined;
            const matches = (name: string) =>
                context.expressionMatchesShape(node.expression, name);
            if (matches("gltfTexSamplerDesc")) {
                if (node.arguments.length !== 2)
                    context.contractError(
                        node,
                        "Expected sampler document and texture info.",
                    );
                context.assertExpressionShape(
                    node.arguments[0]!,
                    "json",
                    "Sampler document",
                );
                return `gltf_source_sampler_desc(json, GltfPbrValue{${lowerer.expression(node.arguments[1]!)}})`;
            }
            if (
                matches("engine._device.createSampler") ||
                matches("getOrCreateSampler")
            ) {
                const cached = matches("getOrCreateSampler");
                if (node.arguments.length !== (cached ? 2 : 1))
                    context.contractError(
                        node,
                        "Expected a sampler allocation descriptor.",
                    );
                if (cached)
                    context.assertExpressionShape(
                        node.arguments[0]!,
                        "engine",
                        "Sampler device owner",
                    );
                return `${cached ? "cached_sampler" : "create_sampler"}(${lowerer.expression(node.arguments[cached ? 1 : 0]!)})`;
            }
            if (
                matches(
                    "engine._deviceLostRecovery?._samplerDescriptors.set",
                ) &&
                node.arguments.length === 2
            )
                return `register_sampler(${node.arguments.map((argument) => lowerer.expression(argument)).join(", ")})`;
            return undefined;
        },
        statement(statement, lowerer, indent) {
            if (ts.isExpressionStatement(statement))
                return [
                    `${indent}${lowerer.expression(statement.expression)};`,
                ];
            if (!ts.isVariableStatement(statement)) return undefined;
            return statement.declarationList.declarations.map((variable) => {
                if (!ts.isIdentifier(variable.name) || !variable.initializer)
                    context.contractError(
                        variable,
                        "Expected an initialized sampler binding.",
                    );
                const name = variable.name.text,
                    init = context.unwrapExpression(variable.initializer);
                const rendered = lowerer.expression(init);
                if (
                    ts.isCallExpression(init) &&
                    context.expressionMatchesShape(
                        init.expression,
                        "gltfTexSamplerDesc",
                    )
                )
                    descriptors.add(name);
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
                    statement,
                );
                return `${indent}const auto ${name} = ${rendered};`;
            });
        },
        returnValue: (expression, lowerer) => lowerer.expression(expression!),
    });
    return `// ${context.provenance(module, "makeSamplerFor")}
template<class Create, class Cached, class Register> GltfMaterialSampler gltf_sampler_for(
    GltfPbrValue json, const ts::JsonValue* info, GltfMaterialSampler default_sampler,
    [[maybe_unused]] Create create_sampler, Cached cached_sampler, Register register_sampler) {
${body}
}`;
}

/** Complete descriptor lookup and formulas use the shared material object lowerer. */
export function lowerGltfSamplers(context: LoweringContext): string {
    const lower = (module: string, name: string, cpp: string) =>
        lowerGltfMaterialObjectFunction(
            context,
            {
                module,
                name,
                cpp,
                declaration: context.functionDeclaration(module, name)
                    .declaration,
            },
            () => undefined,
        );
    const descriptor = context.functionDeclaration(
        module,
        "gltfTexSamplerDesc",
    ).declaration;
    const returned = descriptor.body!.statements.at(-1);
    const object =
        returned &&
        ts.isReturnStatement(returned) &&
        returned.expression &&
        context.unwrapExpression(returned.expression);
    if (!object || !ts.isObjectLiteralExpression(object))
        context.contractError(
            descriptor,
            "Expected a returned sampler descriptor.",
        );
    for (const property of context.findNodes(
        object,
        (node): node is ts.PropertyAssignment => ts.isPropertyAssignment(node),
    ))
        if (
            !gpuSamplerDescriptorMembers.has(
                context.propertyName(property.name) ?? "",
            )
        )
            context.contractError(
                property,
                "Unrepresented glTF sampler descriptor property.",
            );
    // Each member a descriptor value holds, as the native descriptor's.
    const projection = [...gpuSamplerDescriptorMembers]
        .map(
            ([property, { field, kind }]) =>
                `    if (const auto value = descriptor.get(${JSON.stringify(property)}); !value.nullish()) result.${field} = value.${kind}();`,
        )
        .join("\n");
    return `${lower(module, "gltfTexSamplerDesc", "gltf_source_sampler_desc")}
${lowerSamplerKey(context)}
TextureSamplerState gltf_project_sampler(const GltfPbrValue& descriptor) {
    GpuSamplerDescriptor result;
${projection}
    return texture_sampler_state(result);
}
GltfPbrValue gltf_sampler_document(const JsonArray& textures, const JsonArray& samplers) {
    auto document = GltfPbrValue::object();
    auto texture_values = GltfPbrValue::array({});
    auto sampler_values = GltfPbrValue::array({});
    for (const auto& texture : textures) texture_values.push(GltfPbrValue{&texture});
    for (const auto& sampler : samplers) sampler_values.push(GltfPbrValue{&sampler});
    document.set("textures", texture_values);
    document.set("samplers", sampler_values);
    return document;
}
${lowerSamplerFor(context)}
GltfSamplerContext::GltfSamplerContext(const JsonArray& source_textures, const JsonArray& source_samplers)
    : document(std::make_shared<GltfPbrValue>(gltf_sampler_document(source_textures, source_samplers))),
      default_sampler(std::make_shared<TextureSamplerState>(gltf_default_sampler_state())) {
    const auto default_descriptor = gltf_default_sampler_descriptor();
    cache.emplace(gltf_source_sampler_key(default_descriptor).string(), default_sampler);
}
GltfMaterialSampler GltfSamplerContext::resolve(const ts::JsonValue* info) {
    if (!document) throw std::runtime_error("This glTF material context has no per-texture sampler resolver.");
    const auto create_sampler = [](const GltfPbrValue& descriptor) -> GltfMaterialSampler {
        return std::make_shared<TextureSamplerState>(gltf_project_sampler(descriptor));
    };
    return gltf_sampler_for(*document, info, default_sampler, create_sampler,
        [&](const GltfPbrValue& descriptor) {
            const auto key = gltf_source_sampler_key(descriptor).string();
            const auto found = cache.find(key);
            if (found != cache.end()) return found->second;
            const auto sampler = create_sampler(descriptor);
            cache.emplace(key, sampler);
            return sampler;
        }, [](const GltfMaterialSampler&, const GltfPbrValue&) {});
}`;
}
