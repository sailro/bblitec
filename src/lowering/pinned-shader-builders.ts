import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import {
    anchorSpecifiersInText,
    pinnedLibraryRoot,
} from "../pinned-shader-composer.js";
import { loadAugmentedModule } from "../pinned-module-loader.js";
import { sharedUpstreamStore } from "../upstream-source.js";

/**
 * One record in a list a builder loops over -- an extra texture's `name`, an
 * option record's flags.
 */
type ShaderTextRecord = Readonly<Record<string, string | boolean | number>>;

/** A value a builder parameter is bound to by name. */
export type ShaderTextBinding =
    string | boolean | number | ShaderTextRecord | readonly ShaderTextRecord[];

/** What the executor reads off the pinned declarations it runs. */
interface PinnedBuilderContext {
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
function bracedShaderText(source: string, open: string, label: string): string {
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
 * A module-scope function of a pinned source module, callable: a builder,
 * or a factory a producer runs against the recording device.
 */
export function pinnedModuleFunction(
    modulePath: string,
    name: string,
): (...parameters: unknown[]) => unknown {
    const value = pinnedModuleBinding(modulePath, name);
    if (typeof value !== "function") {
        throw new Error(
            `Pinned ${modulePath} does not define a function '${name}'.`,
        );
    }
    return (...parameters: unknown[]): unknown => {
        const result: unknown = Reflect.apply(value, undefined, parameters);
        return result;
    };
}

/**
 * One module-scope binding of a packaged pinned module. The module is
 * loaded once, with every top-level declaration exported, so two builders
 * of one module share its instance.
 */
const loadedModules = new Map<
    string,
    { text: string; bindings: Readonly<Record<string, unknown>> }
>();

function pinnedModuleValue(
    packaged: string,
    text: string,
    name: string,
): unknown {
    let loaded = loadedModules.get(packaged);
    if (!loaded || loaded.text !== text) {
        loaded = {
            text,
            bindings: loadAugmentedModule(
                anchorSpecifiersInText(text, packaged),
                packaged,
            ),
        };
        loadedModules.set(packaged, loaded);
    }
    const { bindings } = loaded;
    if (!Object.hasOwn(bindings, name))
        throw new Error(
            `Pinned ${packaged} declares no module-scope '${name}'.`,
        );
    return bindings[name];
}
