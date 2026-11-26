/**
 * The generic TypeScript user-code surface shared by the
 * `language-constructs-*.test.ts` files: every source runs its own
 * assertions in JavaScript first, then the generated C++ must build and
 * run them identically.
 */

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

export const native = optionalNativeFixtureTools(false);

export async function executeGeneratedAssertions(
    t: TestContext,
    name: string,
    source: string,
): Promise<void> {
    await t.test(
        "generated C++ executes the same assertions",
        { skip: !native },
        () => {
            runGeneratedProgram(native!, `language-constructs/${name}`, source);
        },
    );
}

/**
 * The snippet sees one deployment query on both sides: the Node run reads
 * it as `location.search`, the compiler folds it as the reference query.
 */
export function check(
    name: string,
    source: string,
    { search = "" }: { search?: string } = {},
): void {
    test(name, async (t) => {
        runInNewContext(
            ts.transpileModule(source, {
                compilerOptions: {
                    target: ts.ScriptTarget.ESNext,
                    module: ts.ModuleKind.None,
                },
            }).outputText,
            {
                // A source with imports (type-only) transpiles as a module.
                exports: {},
                location: { search },
                URLSearchParams,
                TextDecoder,
                TextEncoder,
                WeakRef,
                atob,
                btoa,
            },
        );
        const result = compileSource(source, {
            fileName: `${name}.ts`,
            search,
        });
        await executeGeneratedAssertions(t, name, result.cpp);
    });
}

/**
 * Asynchronous work that needs an owned promise runs in an application
 * realm; the snippet closes it once its last assertion has run, which both
 * sides observe.
 */
export function checkInRealm(name: string, source: string): void {
    test(name, async (t) => {
        let closed = false;
        runInNewContext(
            ts.transpileModule(source, {
                compilerOptions: {
                    target: ts.ScriptTarget.ESNext,
                    module: ts.ModuleKind.None,
                },
            }).outputText,
            {
                close: () => (closed = true),
                setTimeout,
                clearTimeout,
                setInterval,
                clearInterval,
                queueMicrotask,
                structuredClone,
                DOMException,
            },
        );
        // A realm may close from a timer callback as well as a reaction.
        for (let turn = 0; turn < 20 && !closed; turn++)
            await new Promise((resolve) => setTimeout(resolve, 0));
        assert.equal(closed, true);
        const result = compileSource(source, { fileName: `${name}.ts` });
        await t.test(
            "generated C++ executes the same assertions",
            { skip: !native },
            () => {
                runGeneratedProgram(
                    native!,
                    `language-constructs/${name}`,
                    result.cpp,
                    { flags: ["/DBBLITE_WORKERS=1"] },
                );
            },
        );
    });
}
