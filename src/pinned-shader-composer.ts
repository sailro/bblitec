/**
 * Executes Babylon Lite's own shader composer.
 *
 * `src/shader/shader-composer.ts` is a pure function over a `ShaderTemplate`
 * and a `ShaderFragment[]`, with no device and no browser globals, and the
 * pinned package ships it as an ES module. So the composed WGSL for a material
 * feature set can be *obtained* rather than reproduced — the same shape the HDR
 * prefilter and the drawn sprite atlas already use, and the second of the two
 * legitimate answers in the project's own rule: lower the pinned AST, or
 * execute the pinned code.
 *
 * This matters because the alternative is what the renderer currently carries:
 * a transcription of the composed fragment plus a hand-written composer that
 * splices extension arms in by text marker. Every arm that transcription misses
 * reads as a small systematic shading bias — the clearcoat base-F0 remap is one
 * that reached a published gate.
 *
 * Nothing here is wired into generation yet. It exists so the swap can be
 * staged against measurements rather than against a rewrite.
 */
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { findRepositoryRoot, readUpstreamPin } from "./upstream-source.js";

/** The composer's output; field names are the pinned module's own. */
export interface ComposedPinnedShader {
    vertexWgsl: string;
    fragmentWgsl: string;
    /** The pin's identity for this permutation, e.g. `ibl|clearcoat`. */
    fragmentKey: string;
    /** The material UBO the composed fragment declares. */
    materialUboSpec: unknown;
    /** The mesh bind-group layout the composed fragment declares. */
    meshBindGroupLayout: unknown;
}

interface PinnedComposerModules {
    composeShader: (template: unknown, fragments: readonly unknown[]) => {
        _vertexWGSL: string;
        _fragmentWGSL: string;
        _fragmentKey: string;
        _materialUboSpec: unknown;
        _meshBGLDescriptor: unknown;
    };
    createPbrTemplate: (config: Record<string, unknown>) => unknown;
}

function pinnedLibraryRoot(): string {
    // Resolve through the pin the way `upstream-source.ts` does. The package
    // exports only its entry point, so `require.resolve` cannot reach the
    // individual modules, and the pin is the provenance the rest of generation
    // already reads.
    const repositoryRoot = findRepositoryRoot();
    const pin = readUpstreamPin(repositoryRoot);
    const packageRoot = resolve(
        repositoryRoot,
        "node_modules",
        ...pin.package.split("/"),
    );
    const library = join(packageRoot, "lib");
    if (!existsSync(library)) {
        throw new Error(
            `Pinned upstream package is not installed: ${pin.package}@${pin.version}. Run npm ci.`,
        );
    }
    return library;
}

/** Import a module from the pinned package by its `lib`-relative path. */
export async function importPinnedModule<T>(
    relativePath: string,
): Promise<T> {
    const url = pathToFileURL(
        join(pinnedLibraryRoot(), relativePath),
    ).href;
    return (await import(url)) as T;
}

async function pinnedComposer(): Promise<PinnedComposerModules> {
    const [composer, template] = await Promise.all([
        importPinnedModule<{
            composeShader: PinnedComposerModules["composeShader"];
        }>("shader/shader-composer.js"),
        importPinnedModule<{
            createPbrTemplate: PinnedComposerModules["createPbrTemplate"];
        }>("material/pbr/pbr-template.js"),
    ]);
    return {
        composeShader: composer.composeShader,
        createPbrTemplate: template.createPbrTemplate,
    };
}

/**
 * Extracts one top-level `fn` definition from composed WGSL, verbatim.
 *
 * Used to take a helper the renderer would otherwise transcribe — the coat's
 * `getR0RemappedForClearCoat` was the first — straight out of the pin's own
 * composed fragment, so a changed formula arrives here instead of drifting.
 * Braces nest only through the body, so a depth scan is enough.
 */
export function extractWgslFunction(
    source: string,
    name: string,
): string {
    const start = source.indexOf(`fn ${name}(`);
    if (start < 0) {
        throw new Error(
            `Pinned composed WGSL declares no function '${name}'.`,
        );
    }
    let depth = 0;
    let seenBody = false;
    for (let index = start; index < source.length; index++) {
        const character = source[index];
        if (character === "{") {
            depth++;
            seenBody = true;
        } else if (character === "}") {
            depth--;
            if (seenBody && depth === 0) {
                return source.slice(start, index + 1);
            }
        }
    }
    throw new Error(
        `Pinned composed WGSL function '${name}' is unterminated.`,
    );
}

/**
 * Extracts one top-level `const` declaration from composed WGSL, verbatim.
 *
 * The iridescence fragment's XYZ→Rec.709 matrix is the case that needs this:
 * it is nine literals a transcription can only get right by luck.
 */
export function extractWgslConst(source: string, name: string): string {
    const start = source.indexOf(`const ${name}`);
    if (start < 0) {
        throw new Error(
            `Pinned composed WGSL declares no const '${name}'.`,
        );
    }
    const end = source.indexOf(";", start);
    if (end < 0) {
        throw new Error(
            `Pinned composed WGSL const '${name}' is unterminated.`,
        );
    }
    return source.slice(start, end + 1);
}

/**
 * Extracts a named declaration, whichever kind the pin used.
 *
 * Callers name what they need, not how it happens to be spelled upstream — a
 * helper that becomes a `const` (or stops being one) then still resolves.
 */
export function extractWgslDeclaration(
    source: string,
    name: string,
): string {
    return source.includes(`fn ${name}(`)
        ? extractWgslFunction(source, name)
        : extractWgslConst(source, name);
}

/**
 * Composes the pinned PBR shader for a template configuration and a set of
 * already-built pinned fragments.
 *
 * The fragments carry their own dependency ids and the composer topologically
 * sorts them, so an incomplete set fails here instead of composing something
 * plausible: `createClearcoatFragment(..., hasIbl = true, ...)` declares `ibl`
 * and the composer refuses it without `createIblFragment`. That refusal is the
 * point — it is the pin stating a contract we would otherwise have to know.
 */
export async function composePinnedPbrShader(
    templateConfig: Record<string, unknown> = {},
    fragments: readonly unknown[] = [],
): Promise<ComposedPinnedShader> {
    const { composeShader, createPbrTemplate } = await pinnedComposer();
    const composed = composeShader(
        createPbrTemplate(templateConfig),
        fragments,
    );
    return {
        vertexWgsl: composed._vertexWGSL,
        fragmentWgsl: composed._fragmentWGSL,
        fragmentKey: composed._fragmentKey,
        materialUboSpec: composed._materialUboSpec,
        meshBindGroupLayout: composed._meshBGLDescriptor,
    };
}
