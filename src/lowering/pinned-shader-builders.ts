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
import { rewriteModuleSpecifiers } from "../module-specifier-rewrite.js";
import { pinnedLibraryRoot } from "../pinned-shader-composer.js";
import { sharedUpstreamStore } from "../upstream-source.js";

/**
 * One record in a list a builder loops over -- an extra texture's `name`, an
 * option record's flags.
 */
export type ShaderTextRecord = Readonly<
    Record<string, string | boolean | number>
>;

/** A value a builder parameter is bound to by name. */
export type ShaderTextBinding =
    string | boolean | number | ShaderTextRecord | readonly ShaderTextRecord[];

/** What the executor reads off the pinned declarations it runs. */
export interface PinnedBuilderContext {
    functionDeclaration(
        modulePath: string,
        symbolName: string,
    ): {
        file: ts.SourceFile;
        declaration: ts.FunctionDeclaration;
    };
    contractError(node: ts.Node, message: string): never;
    /**
     * The packaged module text to execute for a pinned source module; the
     * installed package's by default. A context standing in a doctored pin
     * supplies both halves -- the declaration read and the module run.
     */
    packagedModuleText?(modulePath: string): string | undefined;
}

/**
 * The pin's shader-text builders and fragment factories, executed.
 *
 * Upstream writes each shader as a function that returns WGSL --
 * `makeSpriteWgsl`, the line material's `vertexSource`, the grid's
 * `buildFragmentSource`, `makeSkinningCode` -- or as a factory returning a
 * record of WGSL slots (`createMorphFragment`, `createPbrTemplate`),
 * branching on permutation flags this port settles at generation. With the
 * permutation known, running the builder IS the shader: the packaged module
 * is loaded with its module-scope declarations exported beside its own
 * exports and called, so the deployed text is the text the browser
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
    public constructor(private readonly context: PinnedBuilderContext) {}

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
        const text = this.call(
            modulePath,
            symbolName,
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

    /**
     * What a pinned builder or factory returns for positional arguments: a
     * fragment record, a template, a prelude. A parameter past the supplied
     * arguments (or bound to `undefined`) takes the pin's default, and one
     * with no default refuses.
     */
    public call(
        modulePath: string,
        symbolName: string,
        args: readonly unknown[],
    ): unknown {
        const { declaration } = this.context.functionDeclaration(
            modulePath,
            symbolName,
        );
        if (args.length > declaration.parameters.length) {
            this.context.contractError(
                declaration,
                `Pinned ${symbolName} takes ${declaration.parameters.length} parameter(s), not ${args.length}.`,
            );
        }
        declaration.parameters.forEach((parameter, index) => {
            if (
                args[index] === undefined &&
                !parameter.initializer &&
                !parameter.questionToken
            ) {
                this.context.contractError(
                    parameter,
                    `Pinned shader builder parameter '${parameter.name.getText()}' is unbound and has no default.`,
                );
            }
        });
        const builder = this.value(modulePath, symbolName);
        if (typeof builder !== "function") {
            return this.context.contractError(
                declaration,
                `Pinned ${modulePath} does not define a function '${symbolName}'.`,
            );
        }
        const result: unknown = Reflect.apply(builder, undefined, [...args]);
        return result;
    }

    /**
     * A module-scope binding of a pinned module as the module holds it once
     * loaded -- a WGSL constant a builder splices (`SKELETON_HELPERS`).
     */
    public value(modulePath: string, name: string): unknown {
        return pinnedModuleBinding(
            modulePath,
            name,
            this.context.packagedModuleText?.(modulePath),
        );
    }

    /**
     * The text at `path` inside a record a pinned factory returned, which
     * refuses naming `origin` when the record no longer carries text there.
     */
    public text(
        record: unknown,
        path: readonly string[],
        origin: ts.Node,
        label: string,
    ): string {
        let value = record;
        for (const key of path) {
            value =
                typeof value === "object" && value !== null
                    ? (Reflect.get(value, key) as unknown)
                    : undefined;
        }
        if (typeof value !== "string") {
            return this.context.contractError(
                origin,
                `Pinned ${label} carries no text at '${path.join(".")}'.`,
            );
        }
        return value;
    }

    /** The body of a braced block of a builder's text. */
    public braced(source: string, open: string, label: string): string {
        return bracedShaderText(source, open, label);
    }
}

/**
 * The body of a braced block of shader text, from an opening marker to the
 * brace that closes it. Counting braces rather than cutting at the first `}`
 * is what keeps a stage whose body opens a block of its own -- a cutout
 * fragment's `discard` guard, say -- from being silently truncated.
 */
export function bracedShaderText(
    source: string,
    open: string,
    label: string,
): string {
    const start = source.indexOf(open);
    if (start < 0) {
        throw new Error(
            `Pinned ${label} is no longer introduced by '${open}'.`,
        );
    }
    let depth = 1;
    for (let index = start + open.length; index < source.length; index += 1) {
        const character = source[index];
        if (character === "{") depth += 1;
        if (character === "}") depth -= 1;
        if (depth === 0) {
            return source.slice(start + open.length, index).trim();
        }
    }
    throw new Error(`Pinned ${label} has no closing brace.`);
}

const loadModule = createRequire(import.meta.url);

/**
 * One loaded instance per packaged module text: its declarations by name.
 * Keyed by the text itself (the augmented file it loads from is named by a
 * digest of it), so the installed module loads once and a doctored copy is
 * a module of its own.
 */
const loadedModules = new Map<string, ReadonlyMap<string, unknown>>();

/** The prefix a module-scope declaration is exported under. */
const exportedAlias = "__bblitecExecuted_";

/**
 * One module-scope binding of a pinned source module as its packaged module
 * holds it once loaded -- the installed text, or `text` standing in for it.
 */
export function pinnedModuleBinding(
    modulePath: string,
    name: string,
    text?: string,
): unknown {
    const packaged = join(
        pinnedLibraryRoot(),
        sharedUpstreamStore().packagedModulePath(modulePath),
    );
    return pinnedModuleValue(
        packaged,
        text ?? readFileSync(packaged, "utf8"),
        name,
    );
}

/**
 * One module-scope binding of a packaged pinned module. The module is
 * loaded once, with every top-level declaration exported, so two builders
 * of one module share its instance.
 */
function pinnedModuleValue(
    packaged: string,
    text: string,
    name: string,
): unknown {
    let bindings = loadedModules.get(text);
    if (bindings === undefined) {
        const names = topLevelDeclarations(text, packaged);
        const augmented = `${anchoredSpecifiers(text, packaged)}\nexport { ${names
            .map((declared) => `${declared} as ${exportedAlias}${declared}`)
            .join(", ")} };\n`;
        const loaded: unknown = loadModule(augmentedModuleFile(augmented));
        bindings = new Map(
            names.map((declared) => [
                declared,
                typeof loaded === "object" && loaded !== null
                    ? (Reflect.get(
                          loaded,
                          `${exportedAlias}${declared}`,
                      ) as unknown)
                    : undefined,
            ]),
        );
        loadedModules.set(text, bindings);
    }
    if (!bindings.has(name)) {
        throw new Error(
            `Pinned ${packaged} declares no module-scope '${name}'.`,
        );
    }
    return bindings.get(name);
}

/** The names a packaged module declares at its top level, from its syntax. */
function topLevelDeclarations(text: string, fileName: string): string[] {
    const file = ts.createSourceFile(
        fileName,
        text,
        ts.ScriptTarget.Latest,
        false,
        ts.ScriptKind.JS,
    );
    const names: string[] = [];
    const bind = (name: ts.BindingName): void => {
        if (ts.isIdentifier(name)) {
            names.push(name.text);
            return;
        }
        for (const element of name.elements) {
            if (!ts.isOmittedExpression(element)) bind(element.name);
        }
    };
    for (const statement of file.statements) {
        if (
            (ts.isFunctionDeclaration(statement) ||
                ts.isClassDeclaration(statement)) &&
            statement.name
        ) {
            names.push(statement.name.text);
        } else if (ts.isVariableStatement(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                bind(declaration.name);
            }
        }
    }
    return names;
}

/**
 * A packaged module's text with every relative module specifier -- static
 * and dynamic imports, re-exports -- made absolute against the module's own
 * directory.
 */
function anchoredSpecifiers(text: string, modulePath: string): string {
    return rewriteModuleSpecifiers(text, modulePath, (specifier) =>
        specifier.text.startsWith("./") || specifier.text.startsWith("../")
            ? {
                  specifier: pathToFileURL(
                      resolve(dirname(modulePath), specifier.text),
                  ).href,
              }
            : undefined,
    );
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
