function fragmentInput(): string {
    return `struct FragmentInput {
    @builtin(position) position: vec4<f32>,
    @location(0) worldPosition: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) tangent: vec4<f32>,
    @location(3) uv: vec2<f32>,
};`;
}

function ditherHelperWgsl(): string {
    // Pinned WGSL_DITHER (shader/wgsl-helpers.ts): position-seeded
    // +-variance/255 noise added by the background fragments.
    return `fn dither(seed: vec2<f32>, varianceAmount: f32) -> f32 {
    let rand = fract(sin(dot(seed, vec2<f32>(12.9898, 78.233))) * 43758.5453);
    let normVariance = varianceAmount / 255.0;
    return mix(-normVariance, normVariance, rand);
}

`;
}

export function backgroundGroundFragmentWgsl(
    provenance: string,
    dither = false,
): string {
    return `// ${provenance}
${dither ? ditherHelperWgsl() : ""}@group(2) @binding(0) var groundTexture: texture_2d<f32>;
@group(2) @binding(1) var groundSampler: sampler;

struct GroundUniforms {
    primaryColorAlpha: vec4<f32>,
    backgroundCenter: vec4<f32>,
    cameraExposure: vec4<f32>,
    imageParameters: vec4<f32>,
}
@group(3) @binding(0) var<uniform> uniforms: GroundUniforms;

${fragmentInput()}

@fragment
fn mainFragment(input: FragmentInput) -> @location(0) vec4<f32> {
    let sampleValue =
        textureSample(groundTexture, groundSampler, input.uv);
    var color =
        max(sampleValue.rgb, vec3<f32>(0.0)) *
        uniforms.primaryColorAlpha.rgb;
    var alpha = uniforms.primaryColorAlpha.a * sampleValue.a;
    let normal = normalize(input.normal);
    let facing = dot(
        normal,
        normalize(
            uniforms.cameraExposure.xyz -
            uniforms.backgroundCenter.xyz,
        ),
    );
    let fade = clamp(facing / 0.1, 0.0, 1.0);
    alpha *= fade * fade;
    color *= uniforms.cameraExposure.w;
    if (uniforms.imageParameters.y > 0.5) {
        color = vec3<f32>(1.0) - exp2(-1.590579 * color);
    }
    color = pow(
        max(color, vec3<f32>(0.0)),
        vec3<f32>(1.0 / 2.2),
    );
    color = clamp(color, vec3<f32>(0.0), vec3<f32>(1.0));
    let highContrast =
        color * color * (vec3<f32>(3.0) - 2.0 * color);
    if (uniforms.imageParameters.x < 1.0) {
        color = mix(
            vec3<f32>(0.5),
            color,
            uniforms.imageParameters.x,
        );
    } else {
        color = mix(
            color,
            highContrast,
            uniforms.imageParameters.x - 1.0,
        );
    }
${dither
        ? `    let premultiplied =
        color * alpha + vec3<f32>(dither(input.worldPosition.xy, 0.5));
    return max(vec4<f32>(premultiplied, alpha), vec4<f32>(0.0));`
        : "    return vec4<f32>(color * alpha, alpha);"}
}
`;
}

/**
 * The pinned solid-colour skybox is *taken*, not rewritten. Its two stages ship
 * as `?raw` string literals with no source-map entry, so they are read out of
 * the packaged module text and re-emitted with every declaration the pin wrote:
 * the mesh struct's member list, the varying members, and both entry bodies are
 * the pin's own bytes.
 *
 * One line is unavoidably ours. Babylon binds the mesh block at `@group(1)` and
 * its per-pass `scene` block at `@group(0)`, which is the WebGPU layout its own
 * pipeline builds; SDL_GPU's D3D12 backend instead fixes vertex uniforms at
 * register space 1 and fragment uniforms at space 3. So the `@group`/`@binding`
 * declarations are re-addressed and nothing else is — including the struct the
 * body reads through `scene.`, whose members come from the pin's own
 * `SCENE_UBO_WGSL` rather than from a list typed here.
 */
export interface PinnedSolidSkyboxSource {
    /** `shaders/skybox.vertex.wgsl`, shared with the HDR skybox arm. */
    vertex: string;
    /** `background-solid-skybox.ts`'s own `skyboxFragSrc`. */
    fragment: string;
    /** `shader/scene-uniforms.ts` `SCENE_UBO_WGSL`, which both stages read. */
    sceneUniforms: string;
}

/** The pinned scene-block members the two skybox stages actually read. */
const solidSkyboxSceneMembers = ["viewProjection", "vEyePosition"] as const;

function pinnedError(what: string): never {
    throw new Error(
        `Pinned Babylon Lite solid-skybox ${what} changed.`,
    );
}

/** Re-indent a minified `name:type` member list, keeping every member's text. */
function members(list: string, what: string): string {
    const parsed = list.split(",").map((member) => member.trim());
    if (parsed.some((member) => !/^(@[\w()0-9 ]+ )?\w+:.+$/.test(member))) {
        pinnedError(what);
    }
    return parsed
        .map((member) => `    ${member.replace(":", ": ")},\n`)
        .join("");
}

/** Re-indent a minified statement list without touching the expressions. */
function statements(body: string): string {
    return body
        .split(";")
        .map((statement) => statement.trim())
        .filter((statement) => statement.length > 0)
        .map((statement) => `    ${statement};`)
        .join("\n");
}

/**
 * The prefix of the pinned scene block the skybox reads, declared with the
 * pin's own member text. The block is truncated at the last member either stage
 * references so the native uniform stays the size the PAL uploads; truncating
 * rather than renaming is what keeps both bodies byte-identical to the pin's.
 */
function solidSkyboxSceneStruct(sceneUniforms: string): string {
    const declaration =
        /^struct (\w+)\{(.+?)\}@group\(0\) @binding\(0\) var<uniform> scene:\1;$/.exec(
            sceneUniforms.trim(),
        );
    if (!declaration) pinnedError("scene uniform block");
    const list = declaration[2]!.split(",").map((member) => member.trim());
    const last = Math.max(
        ...solidSkyboxSceneMembers.map((name) =>
            list.findIndex((member) => member.startsWith(`${name}:`)),
        ),
    );
    if (
        solidSkyboxSceneMembers.some(
            (name) =>
                !list.some((member) => member.startsWith(`${name}:`)),
        )
    ) {
        pinnedError("scene uniform members");
    }
    return (
        "struct SceneUniforms {\n" +
        members(list.slice(0, last + 1).join(","), "scene uniform members") +
        "}\n"
    );
}

function solidSkyboxMeshStruct(fragment: string): string {
    const declaration =
        /^struct (\w+)\{(.+?)\}@group\(1\) @binding\(0\) var<uniform> mesh:\1;/.exec(
            fragment,
        );
    if (!declaration) pinnedError("mesh uniform block");
    return (
        "struct SolidSkyboxUniforms {\n" +
        members(declaration[2]!, "mesh uniform members") +
        "}\n"
    );
}

function takePinnedEntry(
    source: string,
    entry: RegExp,
    what: string,
): { parameter: string; varying: string; body: string } {
    const match = entry.exec(source);
    if (!match) pinnedError(`${what} entry point`);
    return {
        parameter: match[1]!,
        varying: match[2]!,
        body: match[3]!,
    };
}

function varyingMembers(
    source: string,
    varying: string,
    what: string,
): string {
    const declaration = new RegExp(
        `struct ${varying}\\{(.+?)\\}`,
    ).exec(source);
    if (!declaration) pinnedError(`${what} varying block`);
    return members(declaration[1]!, `${what} varying members`);
}

export function solidSkyboxVertexWgsl(
    provenance: string,
    pinned: PinnedSolidSkyboxSource,
): string {
    const taken = takePinnedEntry(
        pinned.vertex,
        /@vertex fn main\(@location\(0\) (\w+):vec3<f32>\)->(\w+)\{([\s\S]*)\}$/,
        "vertex",
    );
    // The pin declares the varying struct once and names it in `var a:d;`, so
    // the body carries the mangled name; re-addressing the declaration means
    // re-addressing that one reference with it.
    const body = statements(taken.body).replace(
        new RegExp(`var (\\w+):${taken.varying};`),
        "var $1: VertexOutput;",
    );
    return `// ${provenance}
${solidSkyboxSceneStruct(pinned.sceneUniforms)}@group(1) @binding(0) var<uniform> scene: SceneUniforms;

${solidSkyboxMeshStruct(pinned.fragment)}@group(1) @binding(1) var<uniform> mesh: SolidSkyboxUniforms;

struct VertexOutput {
${varyingMembers(pinned.vertex, taken.varying, "vertex")}}

@vertex
fn mainVertex(@location(0) ${taken.parameter}: vec3<f32>) -> VertexOutput {
${body}
}
`;
}

export function solidSkyboxFragmentWgsl(
    provenance: string,
    pinned: PinnedSolidSkyboxSource,
): string {
    const taken = takePinnedEntry(
        pinned.fragment,
        /@fragment fn main\((\w+):(\w+)\)->@location\(0\) vec4<f32>\{([\s\S]*)\}$/,
        "fragment",
    );
    return `// ${provenance}
${ditherHelperWgsl()}${solidSkyboxMeshStruct(pinned.fragment)}@group(3) @binding(0) var<uniform> mesh: SolidSkyboxUniforms;

struct FragmentInput {
    // Measured: D3D12 refuses the pipeline outright without it
    // ("SDL_CreateGPUGraphicsPipeline solid skybox: The parameter is
    // incorrect"), because it links the two stages by hardware register. The
    // pin's own fragment input omits it; this line and the bindings are the
    // whole of what is not taken from the package.
    @builtin(position) clipPos: vec4<f32>,
${varyingMembers(pinned.fragment, taken.varying, "fragment")}}

@fragment
fn mainFragment(${taken.parameter}: FragmentInput) -> @location(0) vec4<f32> {
${statements(taken.body)}
}
`;
}

export function backgroundSkyboxFragmentWgsl(
    provenance: string,
    dither = false,
): string {
    return `// ${provenance}
${dither ? ditherHelperWgsl() : ""}@group(2) @binding(0) var skyboxTexture: texture_cube<f32>;
@group(2) @binding(1) var skyboxSampler: sampler;

struct SkyboxUniforms {
    primaryColorExposure: vec4<f32>,
    backgroundCenter: vec4<f32>,
    imageParameters: vec4<f32>,
}
@group(3) @binding(0) var<uniform> uniforms: SkyboxUniforms;

${fragmentInput()}

@fragment
fn mainFragment(input: FragmentInput) -> @location(0) vec4<f32> {
    let direction = normalize(
        input.worldPosition - uniforms.backgroundCenter.xyz,
    );
    var color = textureSampleLevel(
        skyboxTexture,
        skyboxSampler,
        direction,
        0.0,
    ).rgb;
    if (uniforms.imageParameters.y < 0.5) {
        color *= uniforms.primaryColorExposure.rgb;
    }
    if (uniforms.imageParameters.w < 0.5) {
        color *= uniforms.primaryColorExposure.a;
        if (uniforms.imageParameters.z > 0.5) {
            color = vec3<f32>(1.0) - exp2(-1.590579 * color);
        }
        color = pow(
            max(color, vec3<f32>(0.0)),
            vec3<f32>(1.0 / 2.2),
        );
        color = clamp(color, vec3<f32>(0.0), vec3<f32>(1.0));
        let highContrast =
            color * color * (vec3<f32>(3.0) - 2.0 * color);
        if (uniforms.imageParameters.x < 1.0) {
            color = mix(
                vec3<f32>(0.5),
                color,
                uniforms.imageParameters.x,
            );
        } else {
            color = mix(
                color,
                highContrast,
                uniforms.imageParameters.x - 1.0,
            );
        }
${dither
        ? `        color = color + vec3<f32>(dither(input.worldPosition.xy, 0.5));
`
        : ""}    }
    return vec4<f32>(max(color, vec3<f32>(0.0)), 1.0);
}
`;
}
