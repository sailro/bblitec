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
 * and EXECUTED rather than restated: its separator rules (when removed
 * whitespace must survive as one space, which comments are injection
 * markers) are exactly the kind of table a second copy agrees with only
 * until upstream changes it. `transformTaggedWgsl` is the entry point the
 * pin's own Vite plugin calls per module, and the reconstructed TypeScript
 * of a pinned module is what it is handed here.
 *
 * Only the tagged-template half is reached. The plugin's other half
 * minifies `?raw` `.wgsl` files through miniray, and those already reach
 * this repository as packaged strings read from `lib/` -- so the miniray
 * import is stood in for by a stub that refuses by name, and the `vite`
 * import is type-only and erased by the transpile.
 */
import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

/** Where the pinned script lives in this repository's corpus. */
export const PINNED_WGSL_BUILD_SCRIPT = "corpus/babylon-lite/scripts/wgsl-minify-plugin.ts";

/** The pin's `transformTaggedWgsl`: built module text, or null when the module tags nothing. */
export type TaggedWgslTransform = (
    code: string,
    id: string,
) => { code: string } | null;

const MINIRAY_STUB =
    "// The pinned plugin's miniray half minifies ?raw .wgsl files, which this\n" +
    "// repository reads from the package already minified; only the tagged\n" +
    "// template half runs here.\n" +
    "function refuse() {\n" +
    '    throw new Error("The pinned WGSL minifier reached miniray, which this port does not execute.");\n' +
    "}\n" +
    "module.exports = { initialize: refuse, minify: refuse };\n";

let loaded: { root: string; transform: TaggedWgslTransform } | undefined;

/**
 * The pinned transform, transpiled once per script digest into a disposable
 * CommonJS module under `artifacts/` and required synchronously -- the
 * source store that calls it is synchronous, and the module's two real
 * dependencies (`typescript`, the pin's own `magic-string` version) resolve
 * from this repository's `node_modules` because the artifact sits inside
 * the checkout.
 */
export function pinnedTaggedWgslTransform(
    repositoryRoot: string,
): TaggedWgslTransform {
    if (loaded && loaded.root === repositoryRoot) {
        return loaded.transform;
    }
    const scriptPath = resolve(repositoryRoot, PINNED_WGSL_BUILD_SCRIPT);
    const source = readFileSync(scriptPath, "utf8");
    const rewired = source.replace(
        /from "miniray";/,
        'from "./miniray-stub.cjs";',
    );
    if (rewired === source) {
        throw new Error(
            `${PINNED_WGSL_BUILD_SCRIPT} no longer imports miniray; the stub rewrite has nothing to replace.`,
        );
    }
    const transpiled = ts.transpileModule(rewired, {
        fileName: "wgsl-minify-plugin.ts",
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
        },
    }).outputText;
    if (/require\("vite"\)/.test(transpiled)) {
        throw new Error(
            `${PINNED_WGSL_BUILD_SCRIPT} imports vite as a value; only its type import is expected.`,
        );
    }
    const digest = createHash("sha256")
        .update(transpiled)
        .digest("hex")
        .slice(0, 16);
    const directory = resolve(
        repositoryRoot,
        "artifacts",
        "pinned-tools",
        `wgsl-minify-${digest}`,
    );
    const modulePath = join(directory, "wgsl-minify-plugin.cjs");
    if (!existsSync(modulePath)) {
        mkdirSync(directory, { recursive: true });
        // Several generating processes may reach this at once: each writes
        // its own temporary and renames it into place, and a rename that
        // lost the race finds the winner's identical bytes already there.
        for (const [name, text] of [
            ["miniray-stub.cjs", MINIRAY_STUB],
            ["wgsl-minify-plugin.cjs", transpiled],
        ] as const) {
            const target = join(directory, name);
            if (existsSync(target)) continue;
            const temporary = `${target}.${process.pid}.tmp`;
            writeFileSync(temporary, text);
            try {
                renameSync(temporary, target);
            } catch (error) {
                if (!existsSync(target)) throw error;
            }
        }
    }
    const require = createRequire(pathToFileURL(modulePath));
    const module = require(modulePath) as {
        transformTaggedWgsl?: unknown;
    };
    if (typeof module.transformTaggedWgsl !== "function") {
        throw new Error(
            `${PINNED_WGSL_BUILD_SCRIPT} no longer exports transformTaggedWgsl.`,
        );
    }
    const transform = module.transformTaggedWgsl as TaggedWgslTransform;
    loaded = { root: repositoryRoot, transform };
    return transform;
}

/**
 * The one fact both halves of this port rely on when they strip the tag:
 * the pin's `wgsl` helper is the identity over its template -- the static
 * parts joined with `String(value)` at each interpolation, which is what a
 * plain template literal evaluates to. Asserted against the declaration
 * that states it, so a helper that started rewriting its text fails
 * generation instead of leaving a scene's shader or a folded builder
 * subtly different from what the pin runs.
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
