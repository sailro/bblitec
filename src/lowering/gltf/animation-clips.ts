import ts from "typescript";
import { LoweringContext } from "../context.js";
import { PinnedReferenceLowerer, type ReferenceValue } from "../pinned-reference-lowerer.js";
import { PINNED_ARITHMETIC_OPERATORS, PINNED_RELATIONAL_OPERATORS, pinnedRemainderCall } from "../pinned-operators.js";

/** The complete clip/sampler/channel section of parseAnimationData. */
export function lowerGltfAnimationClips(context: LoweringContext): string {
    const module = "src/loader-gltf/gltf-animation.ts";
    const { file, declaration } = context.functionDeclaration(module, "parseAnimationData");
    const statements = declaration.body!.statements;
    const end = statements.findIndex(statement => ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some(variable => ts.isIdentifier(variable.name) && variable.name.text === "nodeCount"));
    if (end < 0) context.contractError(declaration, "Expected the complete animation clip section.");
    const records = new Map([
        ["GltfParsedSampler", new Map([["input", "float32"], ["output", "float32"], ["interpolation", "number"]])],
        ["GltfParsedChannel", new Map([["samplerIdx", "number"], ["nodeIdx", "number"], ["path", "number"]])],
        ["GltfParsedClip", new Map([["name", "string"], ["channels", "GltfParsedChannel[]"], ["samplers", "GltfParsedSampler[]"], ["duration", "number"]])],
    ]);
    const bindings = new Map<string, ReferenceValue>([
        ["json", { cpp: "json", type: "json" }],
        ["_parsePointerChannel", { cpp: "pointer_parser_enabled", type: "boolean" }],
        ["INTERP_LINEAR", { cpp: context.doubleLiteral(context.numericValue(ts.factory.createIdentifier("INTERP_LINEAR"), file)), type: "number" }],
    ]);
    const lookups = new Map<string, { cpp: string; definition: string }>();
    for (const name of ["INTERP_MAP", "PATH_MAP"]) {
        const source = context.moduleScopeConstant(file, name);
        if (!source || !ts.isObjectLiteralExpression(source)) context.contractError(declaration, `Expected animation ${name} entries.`);
        const entries = source.properties.map(property => {
            if (!ts.isPropertyAssignment(property)) context.contractError(property, "Expected a named animation lookup value.");
            const key = context.propertyName(property.name);
            if (!key) context.contractError(property.name, "Expected an animation lookup key.");
            return `{${JSON.stringify(key)}, ${context.doubleLiteral(context.numericValue(property.initializer, file))}}`;
        });
        const cpp = `gltf_${name.toLowerCase()}`;
        lookups.set(name, { cpp, definition: `static constexpr std::array<std::pair<std::string_view, double>, ${entries.length}> ${cpp}{{${entries.join(", ")}}};` });
    }
    const numeric = (value: ReferenceValue): string => value.type === "json" ? `(${value.cpp}).number()` : value.cpp;
    const jsonValue = (value: ReferenceValue): string => `GltfPbrValue{${value.cpp}}`;
    const lowerer = new PinnedReferenceLowerer(context, {
        records, functions: new Map(), bindings, returnType: "void",
        typeAliases: new Map([["AnimationClip", "GltfParsedClip"], ["AnimationSampler", "GltfParsedSampler"], ["AnimationChannel", "GltfParsedChannel"]]),
        storage: new Map([["json", "GltfPbrValue"], ["accessor", "GltfAccessorView"], ["float32", "GltfAnimationSamples"]]),
        iterable: value => value.type === "json" ? { cpp: `GltfAnimationJsonArray{${value.cpp}}`, type: "json[]" } : undefined,
        expression(node, expected, lowerer) {
            const adapted = (cpp: string): ReferenceValue => expected === "number" ? { cpp: `(${cpp}).number()`, type: "number" }
                : expected === "string" ? { cpp: `(${cpp}).string()`, type: "string" } : { cpp, type: "json" };
            if (ts.isIdentifier(node) && node.text === "undefined") return { cpp: "GltfPbrValue{}", type: "json" };
            if (ts.isPropertyAccessExpression(node)) {
                const owner = lowerer.expression(node.expression);
                if (owner.type === "json") {
                    const cpp = `(${owner.cpp}).get(${JSON.stringify(node.name.text)}, ${!!node.questionDotToken})`;
                    return node.name.text === "length" ? { cpp: `(${cpp}).number()`, type: "number" } : adapted(cpp);
                }
                if (owner.type === "accessor") {
                    if (node.name.text === "_data") return owner;
                    if (node.name.text === "_count") return { cpp: `static_cast<double>(${owner.cpp}.accessor.count)`, type: "number" };
                    if (node.name.text === "_componentCount") return { cpp: `static_cast<double>(component_count(${owner.cpp}.accessor.type))`, type: "number" };
                    context.contractError(node, "Unsupported animation accessor field.");
                }
                if (owner.type === "float32" && node.name.text === "length") return { cpp: `static_cast<double>(${owner.cpp}.size())`, type: "number" };
            }
            if (ts.isElementAccessExpression(node)) {
                if (ts.isIdentifier(node.expression) && lookups.has(node.expression.text)) {
                    const key = lowerer.expression(node.argumentExpression);
                    return { cpp: `gltf_animation_lookup(${lookups.get(node.expression.text)!.cpp}, ${jsonValue(key)}.text())`, type: "optional:number" };
                }
                const owner = lowerer.expression(node.expression), index = lowerer.expression(node.argumentExpression);
                if (owner.type === "json") return adapted(`(${owner.cpp}).at(${numeric(index)}, ${!!node.questionDotToken})`);
                if (owner.type === "float32") return { cpp: `static_cast<double>(${owner.cpp}.at(gltf_checked_index(${numeric(index)})))`, type: "number" };
            }
            if (ts.isBinaryExpression(node)) {
                const left = lowerer.expression(node.left);
                const operator = node.operatorToken.kind;
                if (operator === ts.SyntaxKind.QuestionQuestionToken && left.type === "json") {
                    const right = lowerer.expression(node.right, expected);
                    const present = right.type === "string" ? "value.string()" : right.type === "number" ? "value.number()" : "value";
                    return { cpp: `([&]() { const auto value = ${left.cpp}; return value.nullish() ? ${right.cpp} : ${present}; }())`, type: right.type };
                }
                if (operator === ts.SyntaxKind.EqualsEqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
                    if (ts.isIdentifier(node.right) && node.right.text === "undefined" && left.type.startsWith("optional:"))
                        return { cpp: `${operator === ts.SyntaxKind.EqualsEqualsEqualsToken ? "!" : ""}(${left.cpp}).has_value()`, type: "boolean" };
                    const right = lowerer.expression(node.right);
                    if (left.type === "json" || right.type === "json") return {
                        cpp: `${operator === ts.SyntaxKind.ExclamationEqualsEqualsToken ? "!" : ""}${jsonValue(left)}.equals(${jsonValue(right)})`, type: "boolean",
                    };
                }
                const arithmetic = PINNED_ARITHMETIC_OPERATORS.get(operator), relational = PINNED_RELATIONAL_OPERATORS.get(operator);
                if (arithmetic || relational) {
                    const right = lowerer.expression(node.right);
                    if (left.type === "json" || right.type === "json") {
                        if (operator === ts.SyntaxKind.PlusToken) return adapted(`${jsonValue(left)}.add(${jsonValue(right)})`);
                        if (operator === ts.SyntaxKind.PercentToken) return { cpp: pinnedRemainderCall(numeric(left), numeric(right)), type: "number" };
                        return { cpp: `(${numeric(left)} ${arithmetic ?? relational} ${numeric(right)})`, type: relational ? "boolean" : "number" };
                    }
                }
            }
            if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
                const name = node.expression.text;
                if (name === "resolveAccessor") {
                    if (node.arguments.length !== 3) context.contractError(node, "Expected animation accessor arguments.");
                    context.assertExpressionShape(node.arguments[0]!, "json", "Animation accessor document");
                    context.assertExpressionShape(node.arguments[1]!, "binChunk", "Animation accessor binary");
                    return { cpp: `resolve_accessor(${numeric(lowerer.expression(node.arguments[2]!))})`, type: "accessor" };
                }
                if (name === "toSamplerFloat32") {
                    if (node.arguments.length !== 3) context.contractError(node, "Expected sampler conversion arguments.");
                    const data = lowerer.expression(node.arguments[0]!);
                    if (data.type !== "accessor") context.contractError(node, "Expected resolved animation sampler storage.");
                    return { cpp: `to_float32(${data.cpp}, ${numeric(lowerer.expression(node.arguments[1]!))}, ${lowerer.expression(node.arguments[2]!).cpp})`, type: "float32" };
                }
                if (name === "_parsePointerChannel") {
                    if (node.arguments.length !== 5) context.contractError(node, "Expected animation pointer arguments.");
                    for (const [index, shape] of [[2, "nodeMap"], [3, "json"], [4, "meshes"]] as const)
                        context.assertExpressionShape(node.arguments[index]!, shape, "Animation pointer owner");
                    return { cpp: `parse_pointer(${lowerer.expression(node.arguments[0]!).cpp}, ${lowerer.expression(node.arguments[1]!).cpp})`, type: "GltfParsedChannel" };
                }
            }
            return undefined;
        },
        statement(statement, _lowerer, indent) {
            if (ts.isReturnStatement(statement)) {
                if (!statement.expression || statement.expression.kind !== ts.SyntaxKind.NullKeyword) context.contractError(statement, "Unsupported animation clip early return.");
                return `${indent}return {};`;
            }
            return undefined;
        },
    });
    const body = lowerer.statements(statements.slice(0, end));
    const structs = [...records].map(([name, fields]) => `struct ${name} {\n${[...fields].map(([field, type]) => `    ${lowerer.storage(type)} ${field}{};`).join("\n")}${name === "GltfParsedChannel" ? "\n    GltfPbrValue pointer;" : ""}\n};`).join("\n");
    const enumNames = (constants: readonly (readonly [string, string])[]) => constants.map(([symbol, name]) =>
        `    if (value == ${context.doubleLiteral(context.numericValue(ts.factory.createIdentifier(symbol), file))}) return ${JSON.stringify(name)};`).join("\n");
    return `struct GltfAnimationJsonArray {
    GltfPbrValue source;
    explicit GltfAnimationJsonArray(GltfPbrValue value) : source(std::move(value)) {
        if (!source.is_array()) throw std::runtime_error("Expected a glTF animation array.");
    }
    std::size_t size() const { return source.size(); }
    GltfPbrValue at(std::size_t index) const { return source.at(static_cast<double>(index)); }
};
${structs}
std::string gltf_animation_path_name(double value) {
${enumNames([["PATH_TRANSLATION", "translation"], ["PATH_ROTATION", "rotation"], ["PATH_SCALE", "scale"], ["PATH_WEIGHTS", "weights"]])}
    if (value == -1.0) return "pointer";
    throw std::runtime_error("Unsupported parsed animation path.");
}
std::string gltf_animation_interpolation_name(double value) {
${enumNames([["INTERP_LINEAR", "LINEAR"], ["INTERP_STEP", "STEP"], ["INTERP_CUBICSPLINE", "CUBICSPLINE"]])}
    throw std::runtime_error("Unsupported parsed animation interpolation.");
}
struct GltfParsedClips { js::Array<js::Ref<GltfParsedClip>> clips; double pointer_channel_count = 0; };
template<std::size_t N>
std::optional<double> gltf_animation_lookup(const std::array<std::pair<std::string_view, double>, N>& table, const std::string& key) {
    for (const auto& [name, value] : table) if (name == key) return value;
    return std::nullopt;
}
// ${context.provenance(module, "parseAnimationData")}
template<class ResolveAccessor, class ToFloat32, class ParsePointer>
GltfParsedClips gltf_animation_clips(GltfPbrValue json, ResolveAccessor resolve_accessor, ToFloat32 to_float32,
    bool pointer_parser_enabled, ParsePointer parse_pointer) {
    ${[...lookups.values()].map(value => value.definition).join("\n    ")}
${body}
    return {local_clips, local_pointerChannelCount};
}`;
}
