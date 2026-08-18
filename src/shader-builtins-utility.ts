/**
 * Utility WGSL. The image-processing function, its per-sample MSAA loop, and
 * the fog falloff are lifted from the pinned package's own string literals —
 * the same discipline as the background fragments. The blit stages, the
 * depth-only fragment, and the diagnostic id/cluster fragments are
 * project-owned tooling with no pinned counterpart and stay written here.
 */
import {
    extractPackagedTemplateLiteral,
    extractWgslFunction,
    readPinnedLibraryModule,
    splitWgslStatements,
} from "./pinned-shader-composer.js";

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

/** Re-indent a lifted statement list, one pinned statement per line. */
function formatStatements(body: string): string {
    return splitWgslStatements(body)
        .map((statement) => `    ${statement}`)
        .join("\n");
}

/**
 * Applies a documented re-homing map, requiring every entry to occur so a
 * pinned rename fails generation instead of leaving a dangling reference.
 */
function rehome(
    source: string,
    replacements: ReadonlyArray<readonly [string, string]>,
    what: string,
): string {
    let text = source;
    for (const [from, to] of replacements) {
        if (!text.includes(from)) {
            utilityLiftError(`${what} ('${from}' is gone)`);
        }
        text = text.split(from).join(to);
    }
    return text;
}

interface PinnedImageProcessing {
    /** The pin's own parameter block, byte for byte: `struct P{e,c,t,p}`. */
    uniformStruct: string;
    /** The pin's uniform declaration, re-addressed to fragment space 3. */
    uniformBinding: string;
    /** The pin's `ip()` — exposure, optional tonemap, gamma, contrast. */
    ip: string;
    /** The pin's per-sample fragment body, re-homed onto our bindings. */
    multisampledBody: string;
}

/**
 * Lifts `frame-graph/image-processing-task.ts`'s shader text out of the
 * packaged module. `common` and the two fragments are function-local template
 * literals there, so they are read from the module text; `ip()` and the
 * parameter block are then the pin's own bytes. The PAL pushes the same 16
 * bytes upstream writes (`[exposure, contrast, toneMappingEnabled, 0]`), so
 * the pin's scalar struct lays out identically to the vec4 it replaces.
 */
function pinnedImageProcessing(): PinnedImageProcessing {
    const module = readPinnedLibraryModule(
        "frame-graph/image-processing-task.js",
    );
    const common = extractPackagedTemplateLiteral(module, "common");
    const uniformStruct = "struct P{e:f32,c:f32,t:f32,p:f32}";
    if (!common.includes(uniformStruct)) {
        utilityLiftError("image-processing parameter block");
    }
    if (!common.includes("@group(0)@binding(0)var<uniform> p:P;")) {
        utilityLiftError("image-processing parameter binding");
    }
    const ip = extractWgslFunction(common, "ip");
    if (!ip.includes("1.590579")) {
        utilityLiftError("image-processing tone-mapping calibration");
    }
    const multisampled =
        /`(@fragment fn fs[^`]*textureNumSamples[^`]*)`/.exec(module);
    if (!multisampled) {
        utilityLiftError("image-processing multisampled fragment");
    }
    const entry = /\{([\s\S]*)\}$/.exec(multisampled[1]!);
    if (!entry) {
        utilityLiftError("image-processing multisampled entry point");
    }
    const multisampledBody = rehome(
        entry[1]!,
        [
            // The pin binds its source as `s` and reads its own position
            // builtin `q`; natively the texture arrives through the storage
            // slot declared below and the position through the shared blit
            // varying block.
            ["textureDimensions(s)", "textureDimensions(sourceTexture)"],
            ["textureNumSamples(s)", "textureNumSamples(sourceTexture)"],
            ["textureLoad(s,", "textureLoad(sourceTexture,"],
            ["q.xy", "input.position.xy"],
        ],
        "image-processing multisampled fragment",
    );
    return {
        uniformStruct,
        uniformBinding: "@group(3)@binding(0)var<uniform> p:P;",
        ip,
        multisampledBody,
    };
}

/** The blit varying block both image-processing entry points consume. */
function imageProcessingFragmentInput(): string {
    return `struct FragmentInput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};`;
}

/**
 * The single-sample image-processing pass. The pin's non-multisampled
 * fragment `textureLoad`s an unfilterable source; SDL_GPU presents the
 * resolved frame through a texture-sampler pair instead, so the wrapper
 * samples the blit uv — which lands on exact texel centres — and everything
 * inside `ip()` is the pin's bytes.
 */
export function imageProcessingFragmentWgsl(): string {
    const pinned = pinnedImageProcessing();
    return `@group(2) @binding(0) var sourceTexture: texture_2d<f32>;
@group(2) @binding(1) var sourceSampler: sampler;

${pinned.uniformStruct}
${pinned.uniformBinding}

${imageProcessingFragmentInput()}

${pinned.ip}

@fragment
fn mainFragment(input: FragmentInput) -> @location(0) vec4<f32> {
    return ip(textureSampleLevel(
        sourceTexture,
        sourceSampler,
        input.uv,
        0.0,
    ));
}
`;
}

/**
 * The pinned `image-processing-task.ts` shape: `ip()` per MSAA sample,
 * averaged after the loop rather than before it. Because tone mapping and
 * gamma are concave, processing the resolved pixel once is brighter than
 * this exactly on raster edges. The loop body is the pin's own text.
 *
 * The source is bound as a fragment *storage* texture, not a sampler pair:
 * a `Texture2DMS` is `Load()`-ed and has no sampler, so SDL_GPU takes it
 * through `SDL_BindGPUFragmentStorageTextures`.
 */
export function imageProcessingMultisampledFragmentWgsl(): string {
    const pinned = pinnedImageProcessing();
    return `@group(2) @binding(0) var sourceTexture: texture_multisampled_2d<f32>;

${pinned.uniformStruct}
${pinned.uniformBinding}

${imageProcessingFragmentInput()}

${pinned.ip}

@fragment
fn mainFragment(input: FragmentInput) -> @location(0) vec4<f32> {
${formatStatements(pinned.multisampledBody)}
}
`;
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
 * packaged module and shared by every native fragment that reads
 * `uniforms.fogInfos`: the standard material fragment and the cubemap skybox.
 *
 * The re-homing is a rename pair plus the uniform flattening: the pin's
 * `calcFogFactor`/`E_FOG` become `bblCalcFogFactor`/`bblFogE` — the names the
 * consuming fragments already call — and `scene.vFogInfos` reads the
 * consumers' own `uniforms.fogInfos` slot.
 *
 * The PBR fragment keeps its own copy in the renderer lowerer. That one
 * is not this text — it is the Tint-normalized dialect, naming
 * `FragmentUniforms` and spelling every literal `1.0f`, and it carries a
 * provenance comment tying it line for line to the pinned WGSL module it
 * was converted from. Regenerating it from here would break that diff.
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
