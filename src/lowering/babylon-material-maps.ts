import ts from "typescript";
import { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import type { PinnedBinding } from "./pinned-numeric-lowerer.js";

/** JSON map entries retain the pin's iteration order and replacement semantics. */
export function lowerBabylonMaterialMaps(context: LoweringContext): string {
    const module = "src/loader-babylon/load-babylon.ts";
    const { file, declaration } = context.functionDeclaration(module, "loadBabylon");
    const loops = ["data.materials", "data.multiMaterials"].map(expression => {
        const matches = context.findNodes(declaration, (node): node is ts.ForOfStatement =>
            ts.isForOfStatement(node) && context.expressionMatchesShape(node.expression, expression));
        const loop = matches[0];
        if (matches.length !== 1 || !loop || !ts.isBlock(loop.parent) || !ts.isIfStatement(loop.parent.parent))
            context.contractError(declaration, `Expected the '${expression}' map construction branch.`);
        return loop;
    });
    const materialLoop = loops[0]!;
    if (!ts.isBlock(materialLoop.statement)) context.contractError(materialLoop, "Expected the material hydration block.");
    const materialStatements = materialLoop.statement.statements;
    const first = materialStatements[0], last = materialStatements.at(-1);
    if (!first || !ts.isVariableStatement(first) || first.declarationList.declarations.length !== 1 ||
        !last || !ts.isExpressionStatement(last) || !ts.isCallExpression(last.expression) ||
        !context.expressionMatchesShape(last.expression.expression, "materialMap.set"))
        context.contractError(materialLoop, "Expected material creation, hydration and map publication.");
    const created = first.declarationList.declarations[0]!;
    if (!ts.isIdentifier(created.name) || !created.initializer || !context.expressionMatchesShape(created.initializer, "createStandardMaterial()"))
        context.contractError(created, "Expected the Standard material factory.");
    const bindings = new Map<string, PinnedBinding>([
        ["data.materials", { cpp: 'document.at("materials")', type: "opaque", absentCpp: '!babylon_json_truthy(document, "materials")' }],
        ["data.multiMaterials", { cpp: 'document.at("multiMaterials")', type: "opaque", absentCpp: '!babylon_json_truthy(document, "multiMaterials")' }],
        ["md.id", { cpp: 'string_or(md, "id")', type: "opaque" }],
        ["mm.id", { cpp: 'string_or(mm, "id")', type: "opaque" }],
        ["mm.materials", { cpp: 'babylon_material_ids(mm.at("materials"))', type: "opaque" }],
        [created.name.text, { cpp: created.name.text, type: "opaque" }],
    ]);
    const body = lowerPinnedBody(file, loops.map(loop => loop.parent.parent as ts.IfStatement), {
        bindings, calls: new Map(),
        forOf(iterated, element) {
            const range = bindings.get(iterated)?.cpp;
            return range ? { range, bindings: new Map([[element, { cpp: element, type: "opaque" }]]) } : undefined;
        },
        statement(statement, lowerer, indent) {
            if (statement === materialLoop) return lowerer.statement(ts.factory.updateForOfStatement(materialLoop,
                materialLoop.awaitModifier, materialLoop.initializer, materialLoop.expression, ts.factory.createBlock([first, last])), indent);
            if (statement === first) return [
                `${indent}const auto ${created.name.getText(file)} = load_material(engine, md, base_path, scene_ambient, reflection_cubes, load_textures);`,
            ];
            if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return undefined;
            const call = statement.expression;
            const target = context.expressionMatchesShape(call.expression, "materialMap.set") ? "materials" :
                context.expressionMatchesShape(call.expression, "multiMatMap.set") ? "multi_materials" : undefined;
            if (!target || call.arguments.length !== 2) return undefined;
            return [`${indent}${target}[${lowerer.expression(call.arguments[0]!)}] = ${lowerer.expression(call.arguments[1]!)};`];
        },
    });
    return `// ${context.provenance(module, "loadBabylon")}
void load_babylon_material_maps(Engine& engine, const Json& document, const std::string& base_path,
    const std::array<double, 3>& scene_ambient, bool load_textures,
    std::unordered_map<std::string, MaterialHandle>& materials,
    std::unordered_map<std::string, std::vector<std::string>>& multi_materials) {
    std::unordered_map<std::string, std::uint32_t> reflection_cubes;
${body}
}`;
}
