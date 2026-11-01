/** A host page given by its host model, for tests that compile without reading one. */
import type { CompileOptions, NativeHostUi } from "../src/compiler/types.js";

/**
 * Compile options hosting `fileName` (compileSource's default) in the page
 * at `path`, whose markup and sheets are `hostUi`.
 */
export function hostUiOptions(
    hostUi: NativeHostUi,
    { path = "fixture.html", fileName = "input.ts" } = {},
): CompileOptions {
    return { fileName, hostPage: { path, entry: fileName, hostUi } };
}
