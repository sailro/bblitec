import ts from "typescript";
import { LoweringContext } from "../context.js";
import { lowerPinnedBody } from "../pinned-body-lowerer.js";

/** JSON storage bridges and the pin's alternate texture-source selection. */
export function lowerGltfParserJson(context: LoweringContext): string {
    const module = "src/loader-gltf/gltf-parser.ts";
    const { file, declaration } = context.functionDeclaration(module, "getTextureImageIndex");
    const parameter = declaration.parameters[0]?.name;
    if (declaration.parameters.length !== 1 || !parameter || !ts.isIdentifier(parameter))
        context.contractError(declaration, "Expected the glTF texture parameter.");
    const path = (expression: ts.Expression): string | undefined => {
        const keys: string[] = [];
        let node = context.unwrapExpression(expression);
        while (ts.isPropertyAccessExpression(node)) {
            keys.unshift(node.name.text);
            node = context.unwrapExpression(node.expression);
        }
        return keys.length && ts.isIdentifier(node) && node.text === parameter.text
            ? `gltf_json_path(texture, {${keys.map(key => JSON.stringify(key)).join(", ")}})` : undefined;
    };
    const body = lowerPinnedBody(file, declaration.body!.statements, {
        bindings: new Map(), calls: new Map(),
        expression(node, lowerer) {
            if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
                const left = path(node.left);
                if (left) return `(${left} ? ${lowerer.expression(node.left)} : ${lowerer.expression(node.right)})`;
            }
            const property = path(node);
            return property ? `gltf_json_number(${property})` : undefined;
        },
        returnValue: (value, lowerer) => `gltf_checked_index(${lowerer.expression(value!)})`,
    });
    return `const ts::JsonValue* gltf_json_path(const JsonObject& object, std::initializer_list<const char*> path) {
    const JsonObject* current = &object;
    const ts::JsonValue* value = nullptr;
    for (auto key = path.begin(); key != path.end(); ++key) {
        value = optional(*current, *key);
        if (!value || value->is_null()) return nullptr;
        if (key + 1 != path.end()) current = &value->as_object();
    }
    return value;
}
double gltf_json_number(const ts::JsonValue* value) {
    return value ? value->as_number() : std::numeric_limits<double>::quiet_NaN();
}
std::size_t gltf_checked_index(double value) {
    if (!std::isfinite(value) || value < 0 || std::floor(value) != value || value >= double(std::numeric_limits<std::size_t>::max()))
        throw std::runtime_error("Invalid glTF index.");
    return static_cast<std::size_t>(value);
}
const JsonArray& gltf_array_or_empty(const JsonObject& object, const std::string& key) {
    static const JsonArray empty;
    const auto* value = optional(object, key);
    return value && !value->is_null() ? value->as_array() : empty;
}
// ${context.provenance(module, "getTextureImageIndex")}
std::size_t texture_image_index(const JsonObject& texture) {
${body}
}`;
}
