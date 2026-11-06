/**
 * Self-checking sources run both ways. Kept apart from native-fixture.ts so
 * fixtures that compile no TypeScript do not load the compiler.
 */
import type { TestContext } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import type { CompileOptions } from "../src/compiler/types.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
    type GeneratedProgramOptions,
} from "./native-fixture.js";

/**
 * Runs the transpiled module in a fresh VM context, its completion value
 * awaited, then the compiled program through `runGeneratedProgram` in
 * `artifacts/<name>`. Skips `t` when the fixture compiler is unavailable.
 */
export async function runSelfCheckingProgram(
    t: TestContext,
    name: string,
    source: string,
    options: GeneratedProgramOptions & { compile?: CompileOptions } = {},
): Promise<void> {
    const { compile, ...run } = options;
    await runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
    );
    const { cpp } = compileSource(source, compile);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(tools, name, cpp, run);
}
