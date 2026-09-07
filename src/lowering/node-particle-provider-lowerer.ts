import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { lowerPinnedFunction, lowerPinnedFunctionParts } from "./pinned-function-lowerer.js";
import { absentBinding, type PinnedBinding, PinnedNumericLowerer } from "./pinned-numeric-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";

const module = "src/particle/node/npe-emitter-provider.ts";

/** Provider validation and storage copying shared by provider-backed systems. */
export function lowerNodeParticleProviderShared(context: LoweringContext): string {
    const copy = lowerPinnedFunction(context, module, "copyMatrix", [
        { pinned: "source", cpp: "source", kind: "numberArray", cppType: "Source" },
        { pinned: "target", cpp: "target", kind: "mat4", annotation: "Mat4" },
    ], { cppName: "npe_copy_matrix", returns: "void", templateParameters: ["typename Source"] });
    const { declaration } = context.functionDeclaration(module, "sampleProvider");
    // The callback returns shared typed-array storage. Keep its value alive for
    // validation and copying; numeric lowering then owns all checks and errors.
    context.assertExpressionShape(context.variableInitializer(declaration, "provided"),
        "provider() as Mat4 | null | undefined", "provider sample");
    const calls = pinnedNumericMathCalls();
    calls.set("Number.isFinite", ([value]) => `std::isfinite(${value})`);
    const sample = lowerPinnedFunctionParts(context, module, "sampleProvider", [
        { pinned: "provider", cpp: "provider", kind: "record", annotation: "NodeParticleEmitterProvider",
            cppType: "bbl::js::Callback<bbl::js::F32Array()>", binding: { cpp: "provider", type: "opaque" } },
    ], {
        cppName: "npe_sample_provider",
        returns: { type: "bbl::js::F32Array", value: (lowerer, expression) => lowerer.expression(expression!) },
        memberBindings: new Map([["provided", { cpp: "provided", type: "f32", staticBoolean: true }]]),
        calls, booleanAnd: true, booleanOr: true,
    });
    const translation = lowerPinnedFunction(context, "src/math/mat4-transform.ts", "mat4GetTranslationToRef", [
        { pinned: "m", cpp: "matrix", kind: "mat4Const" },
        { pinned: "out", cpp: "out", kind: "record", annotation: "Vec3", cppType: "Vec3d",
            mutableRecord: true, binding: { cpp: "out", type: "vec3" } },
    ], { cppName: "npe_provider_translation", returns: "void" });
    return `${copy}\n\n// ${sample.provenance}\n${sample.declaration} {\n    const auto provided = provider();\n${sample.body}\n}\n\n${translation}`;
}

/**
 * Residualize the pin's setup and frame closure over stable native members.
 * Reached evaluators cannot access emitterInverseWorldMatrices in the live
 * evaluator environment, so its initially empty list stays empty. A graph
 * requiring inverse registration refuses before reaching this lowering.
 */
export function lowerNodeParticleProviderState(context: LoweringContext): string {
    const { file, declaration } = context.functionDeclaration(module, "withNodeParticleEmitterProvider");
    const property = context.findNodes(declaration, ts.isPropertyAssignment).find((node) =>
        node.name.getText(file) === "_setupEmitter");
    if (!property || !ts.isArrowFunction(property.initializer) || !ts.isBlock(property.initializer.body)) {
        context.contractError(declaration, "Expected the provider setup closure.");
    }
    const setup = property.initializer.body;
    const initializers = new Map<string, string | undefined>([
        ["system", "state.system!"], ["emitter", "state.emitter"],
        ["emitterWorldMatrix", "allocateMat4()"], ["emitterInverseWorldMatrices", "[]"],
        ["nextMatrix", "allocateMat4()"], ["inverseScratch", undefined],
        ["prepareFrame", "system._prepareFrame"],
    ]);
    const statements: ts.Statement[] = [];
    let frame: ts.ArrowFunction | undefined;
    const links = new Set(["state.emitterWorldMatrix", "state.emitterInverseWorldMatrices"]);
    for (const statement of setup.statements) {
        if (ts.isVariableStatement(statement)) {
            for (const variable of statement.declarationList.declarations) {
                const name = variable.name.getText(file);
                if (!initializers.has(name)) context.contractError(variable, "Unexpected provider setup storage.");
                const expected = initializers.get(name);
                if (expected === undefined) {
                    if (variable.initializer) context.contractError(variable, "Provider inverse scratch is no longer lazy.");
                } else if (variable.initializer) {
                    context.assertExpressionShape(variable.initializer, expected, `provider ${name} initialization`);
                } else context.contractError(variable, `Missing provider ${name} initialization.`);
                initializers.delete(name);
            }
            statements.push(statement);
            continue;
        }
        const expression = ts.isExpressionStatement(statement) ? context.unwrapExpression(statement.expression) : undefined;
        if (expression && ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            const target = expression.left.getText(file);
            if (links.delete(target)) {
                context.assertExpressionShape(expression.right, target.slice("state.".length), "provider stable reference");
                continue;
            }
            if (target === "system._prepareFrame" && ts.isArrowFunction(expression.right) && !frame) {
                frame = expression.right;
                continue;
            }
            context.contractError(expression, "Unexpected provider setup assignment.");
        }
        statements.push(statement);
    }
    if (initializers.size || links.size || !frame || !ts.isBlock(frame.body) || frame.parameters.length) {
        context.contractError(setup, "Provider setup storage or frame-hook contract changed.");
    }
    const bindings = (): Map<string, PinnedBinding> => new Map([
        ["system", { cpp: "state", type: "opaque" }],
        ["emitter", { cpp: "state.emitter", type: "vec3" }],
        ["emitterWorldMatrix", { cpp: "state.emitter_world_matrix", type: "f32" }],
        ["nextMatrix", { cpp: "state.next_emitter_matrix", type: "f32" }],
        ["initialMatrix", { cpp: "snapshot", type: "f32" }],
        ["emitterInverseWorldMatrices", { cpp: "/* empty inverse list */", type: "opaque" }],
        ["emitterInverseWorldMatrices.length", { cpp: "0.0", type: "scalar", staticNumber: 0 }],
        ["inverseScratch", absentBinding()], ["prepareFrame", absentBinding()],
        ["provider", { cpp: "state.emitter_provider", type: "opaque" }],
    ]);
    const calls = new Map<string, (args: readonly string[]) => string>([
        ["copyMatrix", (args) => `npe_copy_matrix(${args.join(", ")})`],
        ["sampleProvider", () => "state.emitter_provider()"],
        ["mat4GetTranslationToRef", (args) => `npe_provider_translation(${args.join(", ")})`],
    ]);
    const lower = (body: readonly ts.Statement[]): string => new PinnedNumericLowerer(file, {
        bindings: bindings(), calls, booleanAnd: true, booleanOr: true,
    }).statements(body, "    ").join("\n");
    return `// ${context.provenance(module, "withNodeParticleEmitterProvider")}
void initialize(State& state, const std::array<float, 16>& snapshot) {
${lower(statements)}
}

void prepare_frame(State& state) {
${lower(frame.body.statements)}
}`;
}
