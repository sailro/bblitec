import type { SpriteShaderSource } from "./lowering/sprite-lowerer.js";
import { indent } from "./shader-builtins-utility.js";

/**
 * The pure-2D sprite shader, in SDL_GPU's binding convention.
 *
 * Every line of arithmetic below comes out of the pinned `makeSpriteWgsl`
 * permutation the sprite lowerer reconstructs (see `SpriteLowerer.shaderSource`);
 * this module only re-homes the resources. Upstream declares one bind group
 * holding the layer UBO plus the atlas pair, which a single WebGPU pipeline
 * can share across both stages. SDL_GPU splits resources by stage instead —
 * vertex uniforms at `@group(1)`, fragment textures at `@group(2)`, fragment
 * uniforms at `@group(3)` — so the same 64-byte layer block is declared in
 * both stages and pushed to both. The bytes and the arithmetic are identical;
 * only which register file holds them differs.
 *
 * `@builtin(position)` stays first in the varying struct: D3D12 links vertex
 * and fragment signatures by hardware register, so moving it shifts every
 * varying.
 */

export function spriteVertexWgsl(
    provenance: string,
    shader: SpriteShaderSource,
): string {
    return `// ${provenance}
struct Lr {
${indent(shader.layerStructFields, "    ")}
};
@group(1) @binding(0) var<uniform> L: Lr;

struct I {
${indent(shader.instanceStructFields, "    ")}
};

struct O {
${indent(shader.varyingStructFields, "    ")}
};

@vertex
fn mainVertex(in: I) -> O {
${indent(shader.vertexBody, "    ")}
}
`;
}

export function spriteFragmentWgsl(
    provenance: string,
    shader: SpriteShaderSource,
): string {
    return `// ${provenance}
struct Lr {
${indent(shader.layerStructFields, "    ")}
};
@group(3) @binding(0) var<uniform> L: Lr;
@group(2) @binding(0) var atlasTex: texture_2d<f32>;
@group(2) @binding(1) var atlasSamp: sampler;

struct O {
${indent(shader.varyingStructFields, "    ")}
};

@fragment
fn mainFragment(in: O) -> @location(0) vec4f {
${indent(shader.fragmentBody, "    ")}
}
`;
}
