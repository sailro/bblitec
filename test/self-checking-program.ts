/**
 * Self-checking sources run both ways. Kept apart from native-fixture.ts so
 * fixtures that compile no TypeScript do not load the compiler.
 */
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import type { CompileOptions } from "../src/compiler/types.js";
import {
    headlessRealmHost,
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

/**
 * Runs a Window program as JavaScript (`runTranspiled`) with `globals` until
 * it closes its realm (`close()`). A timer callback's throw goes to
 * `thrown`; the run fails on what `failures` collects or when the program
 * never closes.
 */
export async function runWindowProgramAsJavaScript(
    source: string,
    globals: Record<string, unknown>,
    failures: string[],
    thrown: (error: unknown) => void,
): Promise<void> {
    let closed = false;
    await runTranspiled(
        source,
        {
            ...globals,
            queueMicrotask,
            setTimeout: (callback: () => void, delay: number) =>
                setTimeout(() => {
                    try {
                        callback();
                    } catch (error) {
                        thrown(error);
                    }
                }, delay),
            close: () => (closed = true),
        },
        ts.ModuleKind.None,
    );
    for (let turn = 0; turn < 20 && !closed && !failures.length; turn++)
        await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(failures, []);
    assert.equal(closed, true);
}

/**
 * Runs a Window program that dispatches constructed keyboard events and
 * closes its realm: first as JavaScript, on a browser-like window (Node's
 * EventTarget), then compiled and run natively in `artifacts/<name>`, where
 * its own assertions must hold the same way.
 */
export async function checkKeyboardWindowProgram(
    t: TestContext,
    name: string,
    source: string,
): Promise<void> {
    const failures: string[] = [];
    await runWindowProgramAsJavaScript(
        source,
        {
            window: new EventTarget(),
            KeyboardEvent: class extends Event {
                public readonly key: string;
                public readonly code: string;
                public readonly shiftKey: boolean;
                public constructor(
                    type: string,
                    init: EventInit & {
                        key: string;
                        code: string;
                        shiftKey?: boolean;
                    },
                ) {
                    super(type, init);
                    this.key = init.key;
                    this.code = init.code;
                    this.shiftKey = init.shiftKey ?? false;
                }
            },
        },
        failures,
        (error) => failures.push(String(error)),
    );
    const result = compileSource(source, {
        fileName: `test/${name.replaceAll("/", "-")}.ts`,
    });
    const tools = optionalNativeFixtureTools();
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(tools, name, result.cpp + headlessRealmHost(), {
        flags: ["/DBBLITE_WORKERS=1", "/DBBLITE_HAS_UI=1"],
        timeoutMs: 10000,
        expectedOutput: "",
    });
}
