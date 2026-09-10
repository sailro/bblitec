import ts from "typescript";
import {gltfPointerClosures, type GltfPointerClosure} from "../../gltf-animation-pointers.js";
import {LoweringContext} from "../context.js";
import {lowerGltfMaterialObjectFunction, type GltfMaterialFunction} from "./material-object-lowerer.js";

export interface GltfPointerWriterFunction extends GltfPointerClosure {
    cpp: string;
    parameters: string[];
    effects: boolean;
}

/** Source writer guards and stores over aliased material/node/light projections. */
export function lowerGltfAnimationPointerWriters(context: LoweringContext): {source: string; writers: GltfPointerWriterFunction[]} {
    const modules = ["src/loader-gltf/animation-pointer.ts", "src/loader-gltf/animation-pointer-ext.ts", "src/loader-gltf/animation-pointer-lights.ts"];
    const helpers = new Map<string, GltfMaterialFunction>();
    const writers: GltfPointerWriterFunction[] = [];
    const helper = (module: string, name: string): string | undefined => {
        const key = `${module}#${name}`, found = helpers.get(key);
        if (found) return found.cpp;
        const file = context.sourceFile(module);
        const declaration = file.statements.find((node): node is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(node) && node.name?.text === name && !!node.body);
        if (!declaration) return undefined;
        const cpp = `gltf_animation_pointer_helper_${modules.indexOf(module)}_${name}`;
        helpers.set(key, {module, name, cpp, declaration});
        for (const call of context.findNodes(declaration.body!, (node): node is ts.CallExpression => ts.isCallExpression(node)))
            if (ts.isIdentifier(call.expression)) helper(module, call.expression.text);
        return cpp;
    };
    const bodies: string[] = [];
    for (const module of modules) for (const closure of gltfPointerClosures(context, module)) {
        const parameters = closure.declaration.parameters.map(parameter => {
            if (!ts.isIdentifier(parameter.name)) context.contractError(parameter, "Expected a named source pointer writer parameter.");
            return parameter.name.text;
        });
        if (parameters.length !== (closure.kind === "lookup" ? 0 : 2)) context.contractError(closure.declaration, "Unrepresented source pointer writer arity.");
        const calls = context.findNodes(closure.declaration.body, (node): node is ts.CallExpression => ts.isCallExpression(node));
        const effects = calls.some(call => context.expressionMatchesShape(call.expression, "setSubtreeVisible") ||
            context.expressionMatchesShape(call.expression, "getGltfPunctualLight") ||
            (ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "_bumpLightVersion") ||
            (ts.isIdentifier(call.expression) && closure.captures.includes(call.expression.text)));
        const cpp = `gltf_animation_pointer_${writers.length}`;
        const names = [...(effects ? ["__pointerEffects"] : []), ...closure.captures, ...parameters];
        if (new Set(names).size !== names.length) context.contractError(closure.declaration, "Ambiguous source pointer writer capture names.");
        const body = closure.declaration.body;
        const text = `function ${cpp}(${names.join(", ")}): ${closure.kind === "lookup" ? "unknown" : "void"} ` +
            (ts.isBlock(body) ? body.getText() : `{ return ${body.getText()}; }`);
        const declaration = ts.createSourceFile(module, text, ts.ScriptTarget.Latest, true).statements[0];
        if (!declaration || !ts.isFunctionDeclaration(declaration)) context.contractError(body, "Expected a source pointer writer function.");
        const target: GltfMaterialFunction = {module, name: cpp, cpp, declaration, sourceSymbol: `writer@${closure.declaration.getStart()}`,
            ...(effects ? {contextParameter: "__pointerEffects", contextType: "GltfAnimationPointerEffects"} : {})};
        bodies.push(lowerGltfMaterialObjectFunction(context, target, name => helper(module, name), (call, lowerer) => {
            const args = () => call.arguments.map(argument => lowerer.expression(argument));
            if (context.expressionMatchesShape(call.expression, "setSubtreeVisible")) {
                if (call.arguments.length !== 2) context.contractError(call, "Expected source visibility target and value.");
                return `__pointerEffects.set_visibility(${args().join(", ")})`;
            }
            if (context.expressionMatchesShape(call.expression, "getGltfPunctualLight")) {
                if (call.arguments.length !== 2) context.contractError(call, "Expected source light lookup owner and index.");
                return `__pointerEffects.lookup_light(${args().join(", ")})`;
            }
            if (ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "_bumpLightVersion") {
                if (call.arguments.length || !call.questionDotToken || call.expression.questionDotToken)
                    context.contractError(call, "Expected the source optional light-version callback.");
                const light = lowerer.expression(call.expression.expression);
                return `[&]() { const auto pointer_light_owner = ${light}; return pointer_light_owner.get("_bumpLightVersion").nullish() ? GltfPbrValue{} : __pointerEffects.bump_light_version(pointer_light_owner); }()`;
            }
            if (ts.isIdentifier(call.expression) && closure.captures.includes(call.expression.text)) {
                if (call.arguments.length) context.contractError(call, "Unrepresented source pointer helper invocation.");
                return `__pointerEffects.invoke_closure(${call.expression.text})`;
            }
            return undefined;
        }));
        writers.push({...closure, cpp, parameters, effects});
    }
    const helperBodies = [...helpers.values()].reverse().map(target => lowerGltfMaterialObjectFunction(context, target,
        name => helper(target.module, name)));
    return {writers, source: `struct GltfAnimationPointerEffects {
    std::function<GltfPbrValue(GltfPbrValue, GltfPbrValue)> set_visibility;
    std::function<GltfPbrValue(GltfPbrValue, GltfPbrValue)> lookup_light;
    std::function<GltfPbrValue(GltfPbrValue)> bump_light_version;
    std::function<GltfPbrValue(GltfPbrValue)> invoke_closure;
};
${helperBodies.join("\n")}
${bodies.join("\n")}
using GltfAnimationPointerFunction = GltfPbrValue (*)(const GltfAnimationPointerEffects&, const GltfPbrValue&, GltfPbrValue, GltfPbrValue);
GltfAnimationPointerFunction gltf_animation_pointer_function(const std::string& site) {
${writers.map(writer => `    if (site == ${JSON.stringify(writer.site)}) return +[]([[maybe_unused]] const GltfAnimationPointerEffects& effects,
        [[maybe_unused]] const GltfPbrValue& captures, [[maybe_unused]] GltfPbrValue output, [[maybe_unused]] GltfPbrValue offset) { return ${writer.cpp}(${[
    ...(writer.effects ? ["effects"] : []), ...writer.captures.map(name => `captures.get(${JSON.stringify(name)})`),
    ...(writer.kind === "writer" ? ["output", "offset"] : []),
].join(", ")}); };`).join("\n")}
    throw std::runtime_error("Unrepresented source animation pointer writer site.");
}`};
}
