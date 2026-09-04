/**
 * The pin's own build step between its source and its package.
 *
 * Since 1.27.0 the package build minifies every template literal tagged
 * with the pin's `wgsl` helper -- whitespace and comments only, `${...}`
 * expressions untouched -- and strips the tag, so the WGSL the browser
 * compiles is no longer the text the source maps carry. Every shader this
 * repository folds from a pinned builder's own AST has to fold from the
 * BUILT text, or it would deploy a stage differing from the browser's in
 * every byte of whitespace.
 *
 * The transform is a script in the upstream repository,
 * `scripts/wgsl-minify-plugin.ts`, pinned here like any other corpus file
 * (the corpus manifest's `tooling` row) and EXECUTED rather than restated:
 * its separator rules -- which removed whitespace must survive as one
 * space, which comments are injection markers -- are exactly the kind of
 * table a second copy agrees with only until upstream changes it.
 * `transformTaggedWgsl` is the entry point the pin's own Vite plugin calls
 * per module, and the reconstructed TypeScript of a pinned module is what
 * it is handed here.
 *
 * Only the tagged-template half is reached. The plugin's other half
 * minifies `?raw` `.wgsl` files through miniray, and those already reach
 * this repository as packaged strings read from `lib/` -- so `miniray` is
 * answered by a stub that refuses by name, and any other module the
 * script's value code requires refuses the same way (`vite` is a type
 * import, erased by the transpile).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import ts from "typescript";

import { cachedBakeSync, moduleIdentity } from "./bake-cache.js";
import { transpileCommonJs } from "./typescript-transpile.js";

/** Where the pinned script lives in this repository's corpus. */
export const PINNED_WGSL_BUILD_SCRIPT = "corpus/babylon-lite/scripts/wgsl-minify-plugin.ts";

/** The pin's `transformTaggedWgsl`: built module text, or null when the module tags nothing. */
export type TaggedWgslTransform = (
    code: string,
    id: string,
) => { code: string } | null;

function refuseMiniray(): never {
    throw new Error(
        "The pinned WGSL minifier reached miniray, which this port does not execute.",
    );
}

/** The miniray half: `?raw` files, which this repository never hands it. */
const MINIRAY_STUB = { initialize: refuseMiniray, minify: refuseMiniray };

let loaded: TaggedWgslTransform | undefined;

/**
 * The pinned transform, executed in this process.
 *
 * The script is transpiled to CommonJS once per (script, TypeScript)
 * through the bake cache and run under `node:vm` with the script's own
 * resolution: its two real dependencies, `typescript` and the pin's own
 * `magic-string` version, resolve from this repository's `node_modules`
 * through the script's path. The result is process-wide -- every store
 * reads the same pin -- so the argument only names the checkout.
 */
export function pinnedTaggedWgslTransform(
    repositoryRoot: string,
): TaggedWgslTransform {
    if (loaded) return loaded;
    const scriptPath = resolve(repositoryRoot, PINNED_WGSL_BUILD_SCRIPT);
    const source = readFileSync(scriptPath);
    const transpiled = Buffer.from(
        cachedBakeSync(
            {
                kind: "pinned-wgsl-build",
                version: "1",
                module: moduleIdentity(import.meta.url),
                browser: false,
                parameters: { typescript: ts.version },
                inputs: [source],
            },
            () =>
                Buffer.from(
                    transpileCommonJs(
                        source.toString("utf8"),
                        "wgsl-minify-plugin.ts",
                    ),
                    "utf8",
                ),
        ),
    ).toString("utf8");
    const scriptRequire = createRequire(pathToFileURL(scriptPath));
    const requireShim = (id: string): unknown => {
        if (id === "miniray") return MINIRAY_STUB;
        if (id === "typescript" || id === "magic-string") {
            return scriptRequire(id);
        }
        throw new Error(
            `${PINNED_WGSL_BUILD_SCRIPT} requires '${id}', which this port does not execute.`,
        );
    };
    const module = { exports: {} as { transformTaggedWgsl?: unknown } };
    vm.compileFunction(transpiled, ["require", "module", "exports"], {
        filename: scriptPath,
    })(requireShim, module, module.exports);
    if (typeof module.exports.transformTaggedWgsl !== "function") {
        throw new Error(
            `${PINNED_WGSL_BUILD_SCRIPT} no longer exports transformTaggedWgsl.`,
        );
    }
    loaded = module.exports.transformTaggedWgsl as TaggedWgslTransform;
    return loaded;
}

/**
 * The one fact every reader relies on when it strips the tag: the pin's
 * `wgsl` helper is the identity over its template -- the static parts
 * joined with `String(value)` at each interpolation, which is what a plain
 * template literal evaluates to. Asserted against the declaration that
 * states it, so a helper that started rewriting its text fails generation
 * instead of leaving a scene's shader or a folded builder subtly different
 * from what the pin runs.
 */
export function assertPinnedWgslTagIsIdentity(file: ts.SourceFile): void {
    const declaration = file.statements.find(
        (statement): statement is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(statement) &&
            statement.name?.text === "wgsl",
    );
    const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();
    const statements = declaration?.body?.statements.map((statement) =>
        normalize(statement.getText(file)),
    );
    const expected = [
        "let source = strings[0]!;",
        "for (let i = 0; i < values.length; i++) { source += String(values[i]) + strings[i + 1]!; }",
        "return source as WgslSource;",
    ];
    if (
        !statements ||
        statements.length !== expected.length ||
        statements.some((statement, index) => statement !== expected[index])
    ) {
        throw new Error(
            `${file.fileName}: the pinned wgsl tag is no longer the identity over its template ` +
                `(${statements?.join(" ") ?? "no wgsl function"}).`,
        );
    }
}
