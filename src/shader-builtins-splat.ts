/**
 * The Gaussian-splat module, deployed as the pin composes it.
 *
 * `gaussian-splatting-pipeline.ts` ships one WGSL module holding both stages
 * -- the EWA / Vrk projection of the 3D anisotropic Gaussian in its vertex
 * entry, the `exp(-r²)·α` density in its fragment entry -- and hands WebGPU
 * that one module for both. So does this port: the text is the stock module,
 * the module `applyGsFragments` spliced for a scene's plugins, or the module
 * `buildShShaderSource` built for a cloud carrying harmonics, byte for byte.
 * Each stage compiles from it at the entry point the module declares, and the
 * compiler keeps what that entry point reads: the four data textures reach
 * the vertex stage alone, and the uniform block reaches the fragment stage
 * only when a plugin body reads it -- the pin's own layout declares binding 0
 * `VERTEX | FRAGMENT` for exactly that. The compaction pass and the `.slots`
 * sidecar re-home the pin's groups for SDL_GPU.
 */

import { type PinnedSplatShModule } from "./pinned-splat-fragments.js";
import { pinnedSplatModuleWgsl } from "./pinned-splat-fragments.js";
import { reflectWgslBindings } from "./shader-ir.js";

function splatError(what: string): never {
    throw new Error(`Pinned Gaussian-splat WGSL ${what}.`);
}

/**
 * Asserts, off the module's own declarations, the group-1 resources both
 * backends build the cloud's bind group from: the uniform block at 0, the
 * point sampler at 1, the four float data textures at 2..5 in the order
 * `buildSplatGeometry` packs them, and -- for a cloud carrying harmonics --
 * the `uint` payload textures from 6 on, one per entry of the pin's own
 * `SH_TEXTURE_COUNT` row. A pin that moves any of them refuses generation
 * rather than compiling a module this port binds in the wrong order.
 */
function assertSplatBindings(wgsl: string, shTextures: number): string {
    const bindings = reflectWgslBindings(wgsl);
    const at = (binding: number) =>
        bindings.find(
            (candidate) =>
                candidate.group === 1 && candidate.binding === binding,
        );
    if (at(0)?.addressSpace !== "uniform") {
        splatError("no longer declares its uniform block at group 1 binding 0");
    }
    if (at(1)?.type?.text !== "sampler") {
        splatError("no longer declares its sampler at group 1 binding 1");
    }
    for (let binding = 2; binding < 6; binding += 1) {
        if (at(binding)?.type?.text !== "texture_2d<f32>") {
            splatError(
                `no longer declares a float data texture at group 1 binding ${binding}`,
            );
        }
    }
    for (let binding = 6; binding < 6 + shTextures; binding += 1) {
        if (at(binding)?.type?.text !== "texture_2d<u32>") {
            splatError(
                `no longer declares a harmonic payload texture at group 1 binding ${binding}`,
            );
        }
    }
    const extra = bindings.filter(
        (candidate) =>
            candidate.group !== 1 || candidate.binding >= 6 + shTextures,
    );
    if (extra.length > 0) {
        splatError(
            `declares ${extra
                .map(
                    ({ group, binding }) =>
                        `@group(${group}) @binding(${binding})`,
                )
                .join(", ")}, which no backend binds`,
        );
    }
    return wgsl;
}

/**
 * The stock module, or the module the pin's own splicer composed for a
 * scene's plugins.
 */
export function pinnedSplatShader(composedModule?: string): string {
    return assertSplatBindings(composedModule ?? pinnedSplatModuleWgsl(), 0);
}

/** The module `buildShShaderSource` built, plugins spliced when named. */
export function pinnedSplatShShader(module: PinnedSplatShModule): string {
    return assertSplatBindings(module.wgsl, module.textureCount);
}
