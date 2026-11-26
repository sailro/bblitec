import type { TestContext } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

/**
 * Runs a program over materials as JavaScript runs it, each factory making a
 * fresh object, then natively where a native compiler is installed; each
 * run checks its own results. Returns the generated C++.
 */
export async function checkMaterialProgram(
    t: TestContext,
    name: string,
    program: string,
): Promise<string> {
    const realm: { finished?: Promise<void> } = {};
    runInNewContext(
        ts.transpileModule(
            program.replace("void main();", "realm.finished = main();"),
            {
                compilerOptions: {
                    target: ts.ScriptTarget.ESNext,
                    module: ts.ModuleKind.CommonJS,
                },
            },
        ).outputText,
        {
            exports: {},
            realm,
            require: () => ({
                createEngine: async () => ({}),
                createStandardMaterial: () => ({}),
            }),
        },
    );
    await realm.finished;
    const { cpp } = compileSource(program);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return cpp;
    }
    runGeneratedProgram(
        tools,
        `material-programs/${name}`,
        `#define main generated_main
${cpp}
#undef main
namespace bbl {
Engine create_engine(EngineOptions) { return {}; }
// Each material is a default record of its own.
MaterialHandle create_standard_material(Engine& engine) {
    engine.materials.emplace_back();
    return MaterialHandle{static_cast<std::uint32_t>(engine.materials.size() - 1)};
}
} // namespace bbl
int main() { return generated_main(); }
`,
        { expectedOutput: "", timeoutMs: 20000 },
    );
    return cpp;
}
