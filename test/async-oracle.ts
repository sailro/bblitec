import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import ts from "typescript";

/** Run a self-checking async source and require its completion signal. */
export async function assertAsyncSourceCloses(source: string): Promise<void> {
    let closed = false;
    await runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.None,
            },
        }).outputText,
        {
            queueMicrotask,
            close: () => {
                closed = true;
            },
        },
    );
    assert.equal(closed, true);
}
