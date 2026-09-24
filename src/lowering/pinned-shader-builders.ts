import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { pinnedLibraryRoot } from "../pinned-shader-composer.js";
import { sharedUpstreamStore } from "../upstream-source.js";
import {
    bracedShaderText,
    type ShaderTextBinding,
    type ShaderTextContext,
} from "./pinned-shader-text.js";

/**
 * The pin's shader-text builders, executed.
 *
 * Upstream writes each shader as a function that returns WGSL --
 * `makeSpriteWgsl`, the line material's `vertexSource`, the grid's
 * `buildFragmentSource` -- branching on permutation flags this port settles
 * at generation. With the permutation known, running the builder IS the
 * shader: the packaged module is loaded with the builder exported beside its
 * own exports and called, so the deployed text is the text the browser
 * compiles, and a pin that rewrites a builder moves what is emitted without
 * this port reading the builder's shape.
 *
 * Loading is synchronous because the lowerers asking for the text are. The
 * augmented module is written once, content-addressed, under the OS temp
 * directory with its relative specifiers anchored to the pinned package, and
 * `require`d: Node loads an ES module synchronously when its graph has no
 * top-level await, and the package modules it imports are then the same
 * instances every asynchronous pinned import shares.
 */
export class PinnedShaderBuilders {
    public constructor(
        private readonly context: Pick<
            ShaderTextContext,
            "functionDeclaration" | "contractError"
        >,
    ) {}

    /**
     * The text one pinned builder returns for a permutation. Parameters bind
     * by the pin's own names; one left unbound takes the pin's default.
     */
    public evaluate(
        modulePath: string,
        symbolName: string,
        parameters: ReadonlyMap<string, ShaderTextBinding>,
    ): string {
        const { declaration } = this.context.functionDeclaration(
            modulePath,
            symbolName,
        );
        const names = declaration.parameters.map((parameter) =>
            ts.isIdentifier(parameter.name)
                ? parameter.name.text
                : this.context.contractError(
                      parameter,
                      `Pinned ${symbolName} destructures a parameter; builders bind by name.`,
                  ),
        );
        for (const name of parameters.keys()) {
            if (!names.includes(name)) {
                this.context.contractError(
                    declaration,
                    `Pinned ${symbolName} takes no parameter '${name}'.`,
                );
            }
        }
        declaration.parameters.forEach((parameter, index) => {
            if (!parameters.has(names[index]!) && !parameter.initializer) {
                this.context.contractError(
                    parameter,
                    `Pinned shader builder parameter '${names[index]}' is unbound and has no default.`,
                );
            }
        });
        const builder = pinnedModuleExport(modulePath, symbolName);
        const text: unknown = Reflect.apply(
            builder,
            undefined,
            names.map((name) => parameters.get(name)),
        );
        if (typeof text !== "string") {
            return this.context.contractError(
                declaration,
                `Pinned ${symbolName} returned ${typeof text}, not shader text.`,
            );
        }
        return text;
    }

    /** The body of a braced block of a builder's text. */
    public braced(source: string, open: string, label: string): string {
        return bracedShaderText(source, open, label);
    }
}

const loadModule = createRequire(import.meta.url);
const loadedExports = new Map<string, unknown>();

/**
 * One module-local symbol of a pinned source module, from the packaged
 * module that carries it, loaded synchronously: a builder, or a factory a
 * producer runs against the recording device.
 */
export function pinnedModuleExport(
    modulePath: string,
    symbolName: string,
): (...parameters: unknown[]) => unknown {
    const key = `${modulePath}#${symbolName}`;
    let value = loadedExports.get(key);
    if (value === undefined) {
        const packaged = join(
            pinnedLibraryRoot(),
            sharedUpstreamStore().packagedModulePath(modulePath),
        );
        const alias = `__bblitecExecuted_${symbolName}`;
        const loaded: unknown = loadModule(
            augmentedModuleFile(
                `${anchoredSpecifiers(
                    readFileSync(packaged, "utf8"),
                    packaged,
                )}\nexport { ${symbolName} as ${alias} };\n`,
            ),
        );
        value =
            typeof loaded === "object" && loaded !== null
                ? Reflect.get(loaded, alias)
                : undefined;
        loadedExports.set(key, value);
    }
    if (typeof value !== "function") {
        throw new Error(
            `Pinned ${modulePath} does not define a function '${symbolName}'.`,
        );
    }
    return (...parameters: unknown[]): unknown => {
        const result: unknown = Reflect.apply(value, undefined, parameters);
        return result;
    };
}

/**
 * A packaged module's text with every relative module specifier -- static
 * and dynamic imports, re-exports -- made absolute against the module's own
 * directory, located by the module's syntax tree.
 */
function anchoredSpecifiers(text: string, modulePath: string): string {
    const file = ts.createSourceFile(
        modulePath,
        text,
        ts.ScriptTarget.Latest,
        false,
        ts.ScriptKind.JS,
    );
    const edits: Array<{ start: number; end: number; text: string }> = [];
    const anchor = (literal: ts.Expression | undefined): void => {
        if (
            literal &&
            ts.isStringLiteral(literal) &&
            (literal.text.startsWith("./") || literal.text.startsWith("../"))
        ) {
            edits.push({
                start: literal.getStart(file),
                end: literal.end,
                text: JSON.stringify(
                    pathToFileURL(resolve(dirname(modulePath), literal.text))
                        .href,
                ),
            });
        }
    };
    const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
            anchor(node.moduleSpecifier);
        } else if (
            ts.isCallExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ImportKeyword
        ) {
            anchor(node.arguments[0]);
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    let anchored = text;
    for (const edit of edits.reverse()) {
        anchored =
            anchored.slice(0, edit.start) +
            edit.text +
            anchored.slice(edit.end);
    }
    return anchored;
}

/** The augmented module, written once per content under the OS temp directory. */
function augmentedModuleFile(text: string): string {
    const directory = join(tmpdir(), "bblitec-pinned-modules");
    mkdirSync(directory, { recursive: true });
    const file = join(
        directory,
        `${createHash("sha256").update(text).digest("hex")}.mjs`,
    );
    if (!existsSync(file)) {
        // Parallel generations may write the same content; the rename makes
        // the file whole before anyone can load it.
        const pending = `${file}.${process.pid}.tmp`;
        writeFileSync(pending, text);
        try {
            renameSync(pending, file);
        } catch (error: unknown) {
            rmSync(pending, { force: true });
            if (!existsSync(file)) throw error;
        }
    }
    return file;
}
