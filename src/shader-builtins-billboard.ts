import type { BillboardShaderSource } from "./lowering/billboard-lowerer.js";
import { fxBlockWgsl } from "./shader-builtins-sprite-fx.js";
import { indent } from "./shader-builtins-utility.js";

/**
 * The world-space billboard shader, in SDL_GPU's binding convention.
 *
 * Every line of arithmetic comes out of the pinned `makeBillboardWgsl`
 * permutation the billboard lowerer reconstructs; this module only re-homes
 * the resources, the way `shader-builtins-sprite.ts` does for the 2D layer
 * and `shader-builtins-background.ts` does for the skybox.
 *
 * Upstream binds the per-pass scene UBO at `@group(0)` and the billboard's
 * own uniform plus atlas at `@group(1)`. SDL_GPU splits resources by stage
 * instead — vertex uniforms at `@group(1)`, fragment textures at `@group(2)`,
 * fragment uniforms at `@group(3)` — so the scene block is declared in the
 * vertex stage that reads it and the system block in the fragment stage that
 * reads it. The struct is named `scene` in both cases, which is what lets the
 * pinned body keep its own `scene.view` and `billboards.opacityMul`
 * references verbatim: the declarations are re-addressed and nothing else is.
 *
 * Only the two scene members the billboard stages actually read are declared,
 * because this pipeline is pushed its own uniform block rather than sharing
 * the full per-pass buffer.
 *
 * `@builtin(position)` stays first in the varying struct: D3D12 links vertex
 * and fragment signatures by hardware register, so moving it shifts every
 * varying.
 */

/** The system uniform block, at whichever group and binding reads it. */
function systemBlockWgsl(
    shader: BillboardShaderSource,
    group: number,
    binding: number,
): string {
    return `struct S {
${indent(shader.systemStructFields, "    ")}
};
@group(${group}) @binding(${binding}) var<uniform> billboards: S;
`;
}

export function billboardVertexWgsl(
    provenance: string,
    shader: BillboardShaderSource,
): string {
    // An axis-locked basis reads `billboards.axisAndCutoff` for its lock
    // axis, so that stage needs the system block as a second vertex uniform.
    // The facing basis reads only the camera and declares neither.
    const systemBlock = shader.vertexReadsSystemBlock
        ? `
${systemBlockWgsl(shader, 1, 1)}`
        : "";
    return `// ${provenance}
struct SceneUniforms {
    viewProjection: mat4x4<f32>,
    view: mat4x4<f32>,
};
@group(1) @binding(0) var<uniform> scene: SceneUniforms;
${systemBlock}
${shader.basisFunction}

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

export function billboardFragmentWgsl(
    provenance: string,
    shader: BillboardShaderSource,
): string {
    // A custom-shader system binds the fx block beside the system block.
    // Both are declared whether or not the caller's body reads them, as
    // upstream declares them; the one a body leaves alone does not reach the
    // compiled shader, and the slots the survivors took are published there.
    const fxBlock = shader.fxStructFields
        ? fxBlockWgsl(shader.fxStructFields, 3, 1)
        : "";
    return `// ${provenance}
${systemBlockWgsl(shader, 3, 0)}@group(2) @binding(0) var atlasTex: texture_2d<f32>;
@group(2) @binding(1) var atlasSamp: sampler;
${shader.extraTextureBindings}${fxBlock}

struct O {
${indent(shader.varyingStructFields, "    ")}
};

@fragment
fn mainFragment(in: O) -> @location(0) vec4f {
${indent(shader.fragmentBody, "    ")}
}
`;
}
