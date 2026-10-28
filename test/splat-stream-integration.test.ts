import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import {
    pinnedRawShaderImports,
    runtimeWgslModules,
} from "../src/lowering/library-shaders.js";
import { SPLAT_STREAM_SHADER_MODULES } from "../src/lowering/splat-stream-library.js";
import { wgslStageStem } from "../src/wgsl-artifacts.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

/**
 * The entry points the pinned library creates pipelines with, read off its
 * own calls: `compute(module, layout, "entry")` in createPipelines and the
 * render pipeline's `{ module, entryPoint }` stages, each by the raw import
 * the module was created from.
 */
function pinnedPipelineEntries(
    context: LoweringContext,
): Map<string, Set<string>> {
    const entries = new Map<string, Set<string>>();
    const imports = pinnedRawShaderImports(
        context,
        SPLAT_STREAM_SHADER_MODULES,
    );
    for (const module of SPLAT_STREAM_SHADER_MODULES) {
        const file = ts.createSourceFile(
            module,
            context.store.getSource(module),
            ts.ScriptTarget.Latest,
            true,
        );
        // `const gatherModule = device.createShaderModule({ code: GATHER_WGSL })`
        // and `module: device.createShaderModule({ ..., code: RENDER_WGSL })`.
        const moduleTexts = new Map<string, string>();
        let renderText: string | undefined;
        const visit = (node: ts.Node): void => {
            if (
                ts.isCallExpression(node) &&
                ts.isPropertyAccessExpression(node.expression) &&
                node.expression.name.text === "createShaderModule"
            ) {
                const descriptor = node.arguments[0];
                const code =
                    descriptor && ts.isObjectLiteralExpression(descriptor)
                        ? descriptor.properties.find(
                              (property): property is ts.PropertyAssignment =>
                                  ts.isPropertyAssignment(property) &&
                                  property.name.getText() === "code",
                          )
                        : undefined;
                const text = code
                    ? imports.find(
                          (raw) =>
                              raw.module === module &&
                              raw.name === code.initializer.getText(),
                      )?.code
                    : undefined;
                assert.ok(
                    text,
                    `${module}: createShaderModule of a raw import`,
                );
                if (ts.isVariableDeclaration(node.parent))
                    moduleTexts.set(node.parent.name.getText(), text);
                else renderText = text;
            }
            if (
                ts.isCallExpression(node) &&
                ts.isIdentifier(node.expression) &&
                node.expression.text === "compute" &&
                node.arguments.length === 3 &&
                ts.isStringLiteral(node.arguments[2]!)
            ) {
                const text = moduleTexts.get(node.arguments[0]!.getText());
                assert.ok(text, "compute() names a created module");
                const set = entries.get(text) ?? new Set<string>();
                set.add(node.arguments[2].text);
                entries.set(text, set);
            }
            if (
                ts.isPropertyAssignment(node) &&
                node.name.getText() === "entryPoint" &&
                ts.isStringLiteral(node.initializer) &&
                module.endsWith("splat-stream-material.ts")
            ) {
                assert.ok(renderText, "the render module precedes its stages");
                const set = entries.get(renderText) ?? new Set<string>();
                set.add(node.initializer.text);
                entries.set(renderText, set);
            }
            ts.forEachChild(node, visit);
        };
        visit(file);
    }
    return entries;
}

test("the splat stream's run-time WGSL compiles every stage the library creates a pipeline with", () => {
    const context = new LoweringContext();
    const imports = pinnedRawShaderImports(
        context,
        SPLAT_STREAM_SHADER_MODULES,
    );
    assert.deepEqual(
        imports.map(({ name }) => name),
        [
            "COMPACT_WGSL",
            "GATHER_WGSL",
            "PROJECT_WGSL",
            "RADIX_WGSL",
            "RENDER_WGSL",
        ],
    );
    const modules = runtimeWgslModules(imports);
    const compiled = new Map(
        modules.map((module) => [
            module.data,
            new Set([
                module.output.slice(
                    "upstream/shaders/".length,
                    -".native.wgsl".length,
                ),
                ...module.alsoStages.map(({ stem }) => stem),
            ]),
        ]),
    );
    const reached = pinnedPipelineEntries(context);
    assert.equal(reached.size, 5);
    for (const [code, entries] of reached) {
        const stems = compiled.get(code);
        assert.ok(stems, "every created module is deployed");
        const expected = [...entries].map((entry) =>
            wgslStageStem(
                code,
                entry,
                entry === "vs" ? "vert" : entry === "fs" ? "frag" : "comp",
            ),
        );
        assert.deepEqual([...stems].sort(), expected.sort());
    }
});

test("createEngine requiredLimits lowers a run-time record into the engine options", (t) => {
    const directory = resolve("artifacts/test-splat-stream-integration");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "worker.ts"), "self.close();");
    const result = compileSource(
        `import { createEngine } from "@babylonjs/lite";
        const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
        worker.terminate();
        function quality(high: boolean) {
            const capacity = (high ? 4_000_000 : 1_000_000) + 10_000;
            return { requiredLimits: { maxBufferSize: capacity * 64, maxStorageBufferBindingSize: capacity * 64 } };
        }
        async function main() {
            const canvas = document.querySelector("canvas")!;
            const limits = quality(location.search.includes("high")).requiredLimits;
            await createEngine(canvas, { requiredLimits: limits });
        }
        void main();`,
        { fileName: resolve(directory, "entry.ts") },
    );
    // The record's members, in property order, read at the call.
    assert.match(
        result.cpp,
        /required_limits_\d+\.emplace_back\("maxBufferSize", v_fn0_limits->maxBufferSize\);\n[^\n]*emplace_back\("maxStorageBufferBindingSize", v_fn0_limits->maxStorageBufferBindingSize\);/,
    );
    assert.match(
        result.cpp,
        /\.required_limits = std::move\([^]*create_realm_engine\(std::move\(/,
    );
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable.");
        return;
    }
    const cpp = resolve(directory, "limits.cpp");
    writeFileSync(cpp, result.cpp);
    runNativeFixtureCompiler(tools, [
        "/Zs",
        "/DBBLITE_WORKERS=1",
        "/DBBLITE_OFFSCREEN_SURFACES=1",
        "/DBBLITE_HAS_UI=1",
        cpp,
    ]);
});
