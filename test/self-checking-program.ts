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
 * Runs the transpiled source in a fresh VM context holding `sandbox`, its
 * completion value awaited.
 */
export async function runTranspiled(
    source: string,
    sandbox: object = {},
    module?: ts.ModuleKind,
): Promise<void> {
    await runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: {
                target: ts.ScriptTarget.ES2022,
                ...(module === undefined ? {} : { module }),
            },
        }).outputText,
        sandbox,
    );
}

/**
 * Runs the source in Node (`runTranspiled`), then the compiled program
 * through `runGeneratedProgram` in `artifacts/<name>`. Skips `t` when the
 * fixture compiler is unavailable.
 */
export async function runSelfCheckingProgram(
    t: TestContext,
    name: string,
    source: string,
    options: GeneratedProgramOptions & { compile?: CompileOptions } = {},
): Promise<void> {
    const { compile, ...run } = options;
    await runTranspiled(source);
    const { cpp } = compileSource(source, compile);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(tools, name, cpp, run);
}
