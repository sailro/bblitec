import { importPinnedModule } from "../src/pinned-shader-composer.js";

/** The composer's output over one template configuration and fragment set. */
export interface ComposedPinnedPbrShader {
    vertexWgsl: string;
    fragmentWgsl: string;
    /** The pin's identity for the permutation, e.g. `ibl|clearcoat`. */
    fragmentKey: string;
}

/**
 * Composes the pinned PBR shader for a template configuration and a set of
 * already-built pinned fragments, straight through the pin's own composer.
 *
 * The fragments carry their own dependency ids and the composer topologically
 * sorts them, so an incomplete set fails here instead of composing something
 * plausible: `createClearcoatFragment(..., hasIbl = true, ...)` declares `ibl`
 * and the composer refuses it without `createIblFragment`. Production
 * composition goes through `createPbrComposer` (`pinned-pbr-variants.ts`);
 * the tests reach the composer directly to guard its own contracts.
 */
export async function composePinnedPbrShader(
    templateConfig: Record<string, unknown> = {},
    fragments: readonly unknown[] = [],
): Promise<ComposedPinnedPbrShader> {
    const [composer, template] = await Promise.all([
        importPinnedModule<{
            composeShader: (
                template: unknown,
                fragments: readonly unknown[],
            ) => {
                _vertexWGSL: string;
                _fragmentWGSL: string;
                _fragmentKey: string;
            };
        }>("shader/shader-composer.js"),
        importPinnedModule<{
            createPbrTemplate: (config: Record<string, unknown>) => unknown;
        }>("material/pbr/pbr-template.js"),
    ]);
    const composed = composer.composeShader(
        template.createPbrTemplate(templateConfig),
        fragments,
    );
    return {
        vertexWgsl: composed._vertexWGSL,
        fragmentWgsl: composed._fragmentWGSL,
        fragmentKey: composed._fragmentKey,
    };
}
