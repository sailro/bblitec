/**
 * Utility WGSL. The fog falloff is lifted from the pinned package's own
 * string literal -- the same discipline as the background fragments. The
 * blit stages, the depth-only fragment, and the diagnostic id/cluster
 * fragments are project-owned tooling with no pinned counterpart and stay
 * written here; the pin's own utility passes are deployed whole by
 * `pinned-utility-passes.ts`.
 */
import {
    extractPackagedTemplateLiteral,
    readPinnedLibraryModule,
    splitWgslStatements,
} from "./pinned-shader-composer.js";

/**
 * Indents a reconstructed stage body to sit inside the struct or function
 * this module wraps it in. Shared because every builtins module that
 * re-homes pinned text needs it.
 */
export function indent(block: string, spaces: string): string {
    return block
        .split("\n")
        .map((line) => (line.length > 0 ? `${spaces}${line}` : line))
        .join("\n");
}

/** Re-indent a lifted statement list, one pinned statement per line. */
export function formatStatements(body: string): string {
    return splitWgslStatements(body)
        .map((statement) => `    ${statement}`)
        .join("\n");
}

/**
 * Applies a documented re-homing map to a lifted body, requiring every
 * entry to occur so a pinned rename fails generation instead of leaving a
 * dangling reference. The `missing` sink names the vanished token in the
 * caller's own pinned-contract voice.
 */
export function rehomeText(
    source: string,
    replacements: ReadonlyArray<readonly [string, string]>,
    missing: (from: string) => never,
): string {
    let text = source;
    for (const [from, to] of replacements) {
        if (!text.includes(from)) {
            missing(from);
        }
        text = text.split(from).join(to);
    }
    return text;
}

export function blitVertexWgsl(): string {
    return `struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn mainVertex(
    @builtin(vertex_index) vertexIndex: u32,
) -> VertexOutput {
    let positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0),
    );
    let uvs = array<vec2<f32>, 3>(
        vec2<f32>(0.0, 1.0),
        vec2<f32>(2.0, 1.0),
        vec2<f32>(0.0, -1.0),
    );
    var output: VertexOutput;
    output.position = vec4<f32>(positions[vertexIndex], 0.0, 1.0);
    output.uv = uvs[vertexIndex];
    return output;
}
`;
}

export function blitFragmentWgsl(): string {
    return `@group(2) @binding(0) var sourceTexture: texture_2d<f32>;
@group(2) @binding(1) var sourceSampler: sampler;

struct FragmentInput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@fragment
fn mainFragment(input: FragmentInput) -> @location(0) vec4<f32> {
    return textureSampleLevel(
        sourceTexture,
        sourceSampler,
        input.uv,
        0.0,
    );
}
`;
}

function utilityLiftError(what: string): never {
    throw new Error(`Pinned Babylon Lite ${what} changed.`);
}

/** The shared re-homing loop, failing in this module's contract voice. */
function rehome(
    source: string,
    replacements: ReadonlyArray<readonly [string, string]>,
    what: string,
): string {
    return rehomeText(source, replacements, (from) =>
        utilityLiftError(`${what} ('${from}' is gone)`),
    );
}

export function depthOnlyFragmentWgsl(): string {
    return `@fragment
fn mainFragment() {
}
`;
}

function diagnosticPrelude(uniformStruct: string): string {
    return `@group(2) @binding(0) var baseColorTexture: texture_2d<f32>;
@group(2) @binding(1) var baseColorSampler: sampler;

${uniformStruct}

struct FragmentInput {
    @builtin(position) position: vec4<f32>,
    @location(0) worldPosition: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) tangent: vec4<f32>,
    @location(3) uv: vec2<f32>,
};

fn diagnosticAlpha(input: FragmentInput, alphaOptions: vec4<f32>) -> f32 {
    let alpha =
        textureSample(baseColorTexture, baseColorSampler, input.uv).a *
        alphaOptions.z;
    if (
        (alphaOptions.x > 0.5 &&
         alphaOptions.x < 1.5 &&
         alpha < alphaOptions.y) ||
        (alphaOptions.x > 1.5 && alpha <= 0.0)
    ) {
        discard;
    }
    return alpha;
}
`;
}

export function diagnosticIdFragmentWgsl(): string {
    return `${diagnosticPrelude(`struct IdUniforms {
    idColor: vec4<f32>,
    alphaOptions: vec4<f32>,
}
@group(3) @binding(0) var<uniform> uniforms: IdUniforms;`)}

@fragment
fn mainFragment(input: FragmentInput) -> @location(0) vec4<f32> {
    _ = diagnosticAlpha(input, uniforms.alphaOptions);
    return uniforms.idColor;
}
`;
}

export function diagnosticClusterFragmentWgsl(): string {
    return `enable primitive_index;

${diagnosticPrelude(`struct ClusterUniforms {
    clusterOptions: vec4<u32>,
    alphaOptions: vec4<f32>,
}
@group(3) @binding(0) var<uniform> uniforms: ClusterUniforms;`)}

@fragment
fn mainFragment(
    input: FragmentInput,
    @builtin(primitive_index) primitiveIndex: u32,
) -> @location(0) vec4<f32> {
    _ = diagnosticAlpha(input, uniforms.alphaOptions);
    let clusterId =
        uniforms.clusterOptions.x +
        primitiveIndex / max(uniforms.clusterOptions.y, 1u);
    return vec4<f32>(
        f32(clusterId & 0xffu) / 255.0,
        f32((clusterId >> 8u) & 0xffu) / 255.0,
        f32((clusterId >> 16u) & 0xffu) / 255.0,
        1.0,
    );
}
`;
}

/**
 * The pinned fog falloff (`shader/wgsl-fog.ts` `WGSL_FOG`), lifted from the
 * packaged module for the native cubemap skybox fragment, which reads its
 * fog parameters from `uniforms.fogInfos`. The composed PBR and Standard
 * variants carry the same pinned text inside their own composition.
 *
 * The re-homing is a rename pair plus the uniform flattening: the pin's
 * `calcFogFactor`/`E_FOG` become `bblCalcFogFactor`/`bblFogE` — the names the
 * skybox specialization calls — and `scene.vFogInfos` reads the skybox's own
 * `uniforms.fogInfos` slot.
 */
export function fogFactorWgsl(): string {
    const fog = extractPackagedTemplateLiteral(
        readPinnedLibraryModule("shader/wgsl-fog.js"),
        "WGSL_FOG",
    );
    const rehomed = rehome(
        fog,
        [
            ["E_FOG", "bblFogE"],
            ["calcFogFactor", "bblCalcFogFactor"],
            ["scene.vFogInfos", "uniforms.fogInfos"],
        ],
        "fog factor (WGSL_FOG)",
    );
    if (rehomed.includes("scene.")) {
        utilityLiftError("fog factor (unmapped scene member)");
    }
    return `${rehomed.trim()}\n`;
}
