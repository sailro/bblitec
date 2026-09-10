import ts from "typescript";
import { LoweringContext } from "../context.js";
import { lowerPinnedBody } from "../pinned-body-lowerer.js";
import { pinnedNumericMathCalls } from "../pinned-operators.js";
import { lowerGltfMaterialObjectFunction } from "./material-object-lowerer.js";
import { identifierParameters } from "./shared.js";

const componentTypes = new Map([["F32", 5126], ["I8", 5120], ["I16", 5122], ["U8", 5121]]);

/** Source converter selection and component conversion over native accessor storage. */
export function lowerGltfAnimationSamplers(context: LoweringContext): string {
    const module = "src/loader-gltf/gltf-sampler-denorm.ts";
    const file = context.sourceFile(module);
    const registrations = context.findNodes(file, (node): node is ts.CallExpression => ts.isCallExpression(node) &&
        context.expressionMatchesShape(node.expression, "_installSamplerConverter"));
    const callback = registrations[0]?.arguments[0];
    if (registrations.length !== 1 || registrations[0]!.arguments.length !== 1 || !callback || !ts.isArrowFunction(callback) ||
        !ts.isBlock(callback.body) || callback.parameters.length !== 3)
        context.contractError(file, "Expected one animation sampler converter registration.");
    const lower = (file: ts.SourceFile, body: readonly ts.Statement[], names: readonly string[]) => lowerPinnedBody(file, body, {
        bindings: new Map([
            [names[0]!, { cpp: "src", type: "f64-buffer" }],
            [names[1]!, { cpp: "length", type: "scalar" }],
            [names[2]!, { cpp: "normalized", type: "bool" }],
            ["_convertSampler", { cpp: "converter_enabled", type: "bool" }],
        ]),
        calls: new Map([...pinnedNumericMathCalls(), ["_convertSampler", args => `gltf_convert_animation_sampler(${args.join(", ")})`]]),
        expression(node, lowerer) {
            if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) {
                context.assertExpressionShape(node.left, names[0]!, "Animation converter source");
                const type = ts.isIdentifier(node.right) ? componentTypes.get(node.right.text) : undefined;
                if (type === undefined) context.contractError(node, "Unsupported animation sampler component type.");
                return `(src.accessor.component_type == ${type})`;
            }
            if (ts.isNewExpression(node) && context.expressionMatchesShape(node.expression, "F32") && node.arguments?.length === 3) {
                context.assertExpressionShape(node.arguments[0]!, `${names[0]}.buffer`, "Animation sampler buffer");
                context.assertExpressionShape(node.arguments[1]!, `${names[0]}.byteOffset`, "Animation sampler offset");
                return `gltf_animation_float32_view(src, ${lowerer.expression(node.arguments[2]!)})`;
            }
            return undefined;
        },
        returnValue: (expression, lowerer) => lowerer.expression(expression!),
    });
    const names = identifierParameters("_installSamplerConverter", file, callback);
    const converter = lower(file, callback.body.statements, names);
    const wrapperModule = "src/loader-gltf/gltf-animation.ts";
    const wrapper = context.functionDeclaration(wrapperModule, "toSamplerFloat32");
    if (wrapper.declaration.parameters.length !== 3)
        context.contractError(wrapper.declaration, "Expected animation sampler wrapper parameters.");
    const wrapperBody = lower(wrapper.file, wrapper.declaration.body!.statements, identifierParameters("toSamplerFloat32", wrapper.file, wrapper.declaration));
    const registry = "src/loader-gltf/gltf-feature-registry.ts", predicate = "hasNonFloatAnimSampler";
    const needsConverter = lowerGltfMaterialObjectFunction(context, {
        module: registry, name: predicate, cpp: "gltf_needs_animation_sampler_converter",
        declaration: context.functionDeclaration(registry, predicate).declaration,
    }, () => undefined);
    return `struct GltfAnimationSamples {
    std::vector<float> values;
    std::string type;
    std::size_t count = 0;
    std::size_t components = 0;
    GltfAnimationSamples() = default;
    GltfAnimationSamples(std::vector<float> data, std::string element_type)
        : values(std::move(data)), type(std::move(element_type)), components(component_count(type)) {
        if (values.size() % components != 0) throw std::runtime_error("Animation sampler has an incomplete element.");
        count = values.size() / components;
    }
    std::size_t size() const { return values.size(); }
    float at(std::size_t index) const { return values.at(index); }
    float component(std::size_t element, std::size_t lane) const {
        if (element >= count || lane >= components) throw std::out_of_range("Animation sampler component is outside its storage.");
        return values.at(element * components + lane);
    }
};
std::vector<float> gltf_animation_float32_view(const GltfAccessorView& src, double length) {
    if (src.accessor.component_type != 5126) throw std::runtime_error("Expected a FLOAT animation sampler view.");
    const auto count = gltf_checked_index(length), components = component_count(src.accessor.type);
    if (src.accessor.count > std::numeric_limits<std::size_t>::max() / components || count > src.accessor.count * components)
        throw std::runtime_error("Animation Float32 view exceeds its accessor.");
    std::vector<float> result(count);
    for (std::size_t index = 0; index < result.size(); ++index) result[index] = static_cast<float>(src[index]);
    return result;
}
// ${context.provenance(module, "_installSamplerConverter")}
std::vector<float> gltf_convert_animation_sampler(const GltfAccessorView& src, double length, bool normalized) {
${converter}
}
// ${context.provenance(wrapperModule, "toSamplerFloat32")}
std::vector<float> gltf_animation_sampler_float32(const GltfAccessorView& src, double length, bool normalized, bool converter_enabled) {
    const auto count = gltf_checked_index(length), components = component_count(src.accessor.type);
    if (src.accessor.count > std::numeric_limits<std::size_t>::max() / components || count > src.accessor.count * components ||
        (src.accessor.buffer_view != std::numeric_limits<std::size_t>::max() && src.views.at(src.accessor.buffer_view).stride != 0 &&
            src.views.at(src.accessor.buffer_view).stride != component_size(src.accessor.component_type) * components))
        throw std::runtime_error("Animation samplers require a bounded contiguous accessor view.");
${wrapperBody}
}
${needsConverter}`;
}
