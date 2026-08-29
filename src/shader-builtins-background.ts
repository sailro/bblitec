/**
 * Background WGSL, lifted from the pinned package rather than transcribed.
 *
 * Every fragment here is built the way the solid skybox established: the pin's
 * own string literals are read out of the packaged modules, their statement
 * lists are re-emitted byte-for-byte, and the only rewrites are the documented
 * interface re-homings — SDL_GPU's register spaces for `@group`/`@binding`,
 * and the native renderer's flattened uniform blocks for the pin's `mesh` and
 * `scene` members. A pinned literal that loses an expected member or marker
 * fails generation naming it; no transcribed fallback exists to fall back to.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    extractPackagedStringLiteral,
    extractPackagedTemplateLiteral,
    splitWgslStatements,
} from "./pinned-shader-composer.js";

/**
 * The shared model vertex output every background fragment consumes. The
 * pinned background materials each declare their own two- or three-member
 * varying block, but natively the ground and both cubemap skyboxes render
 * through the shared model vertex stage, so its five-member signature is the
 * interface — D3D12 links the stages by hardware register. Member accesses in
 * the lifted bodies are re-homed onto these names.
 */
function fragmentInput(): string {
    return `struct FragmentInput {
    @builtin(position) position: vec4<f32>,
    @location(0) worldPosition: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) tangent: vec4<f32>,
    @location(3) uv: vec2<f32>,
};`;
}

function backgroundLiftError(what: string): never {
    throw new Error(`Pinned Babylon Lite background ${what} changed.`);
}

/** Re-indent a lifted statement list, one pinned statement per line. */
function formatStatements(body: string): string {
    return splitWgslStatements(body)
        .map((statement) => `    ${statement}`)
        .join("\n");
}

/**
 * Applies the documented re-homing map to a lifted body. Every entry must
 * occur — a missing token means the pin no longer reads the member the native
 * uniform layout was built to feed, which is a contract change to surface.
 */
function rehome(
    source: string,
    replacements: ReadonlyArray<readonly [string, string]>,
    what: string,
): string {
    let text = source;
    for (const [from, to] of replacements) {
        if (!text.includes(from)) {
            backgroundLiftError(`${what} ('${from}' is gone)`);
        }
        text = text.split(from).join(to);
    }
    return text;
}

/**
 * After re-homing, no pinned-side block reference may survive: a leftover
 * `mesh.` or `scene.` member is one the pin added and the native uniform
 * layout does not carry yet.
 */
function assertFullyRehomed(text: string, what: string): void {
    const leftover = /(?:mesh|scene)\.\w+/.exec(text);
    if (leftover) {
        backgroundLiftError(
            `${what} (no native re-homing for '${leftover[0]}')`,
        );
    }
}

// ---------------------------------------------------------------------------
// Pinned sources
// ---------------------------------------------------------------------------

export interface PinnedDitherWgsl {
    /** `shader/wgsl-helpers.ts` `WGSL_DITHER`: the position-seeded noise. */
    dither: string;
    /** `WGSL_NO_DITHER`: the pin's zero-noise stand-in, same signature. */
    noDither: string;
}

/**
 * Reads the pin's own dither pair. Upstream composes one of the two in front
 * of every background fragment (`enableNoise ? WGSL_DITHER : WGSL_NO_DITHER`),
 * so the undithered variant is the pin's zero function, not an edited body.
 */
export function readPinnedDitherWgsl(
    packageRoot: string,
): PinnedDitherWgsl {
    const helpers = readFileSync(
        resolve(packageRoot, "lib/shader/wgsl-helpers.js"),
        "utf8",
    );
    const dither = extractPackagedTemplateLiteral(helpers, "WGSL_DITHER");
    for (const marker of ["fn dither(", "12.9898, 78.233", "43758.5453"]) {
        if (!dither.includes(marker)) {
            backgroundLiftError(`dither helper (WGSL_DITHER '${marker}')`);
        }
    }
    const noDither = extractPackagedStringLiteral(helpers, "WGSL_NO_DITHER");
    if (!noDither.includes("fn dither(") || !noDither.includes("return 0.0;")) {
        backgroundLiftError("no-dither helper (WGSL_NO_DITHER)");
    }
    return { dither, noDither };
}

export interface PinnedBackgroundGroundSource {
    /** `background-ground.ts`'s own `groundFragSrc`. */
    fragment: string;
    /** The module's own `WGSL_IMAGE_PROCESSING` copy (`applyImageProcessing`). */
    imageProcessing: string;
    dither: PinnedDitherWgsl;
}

export function readPinnedBackgroundGroundSource(
    packageRoot: string,
): PinnedBackgroundGroundSource {
    const module = readFileSync(
        resolve(packageRoot, "lib/material/pbr/background-ground.js"),
        "utf8",
    );
    return {
        fragment: extractPackagedStringLiteral(module, "groundFragSrc"),
        imageProcessing: extractPackagedTemplateLiteral(
            module,
            "WGSL_IMAGE_PROCESSING",
        ),
        dither: readPinnedDitherWgsl(packageRoot),
    };
}

export interface PinnedBackgroundSkyboxSource {
    /** `background-dds-skybox.ts`'s own `ddsSkyboxVertSrc`. */
    ddsVertex: string;
    /** `background-dds-skybox.ts`'s own `ddsSkyboxFragSrc`. */
    ddsFragment: string;
    /** `background-hdr-skybox.ts`'s own `skyboxHdrFragSrc`. */
    hdrFragment: string;
    dither: PinnedDitherWgsl;
}

export function readPinnedBackgroundSkyboxSource(
    packageRoot: string,
): PinnedBackgroundSkyboxSource {
    const ddsModule = readFileSync(
        resolve(
            packageRoot,
            "lib/material/pbr/background-dds-skybox.js",
        ),
        "utf8",
    );
    return {
        ddsVertex: extractPackagedStringLiteral(
            ddsModule,
            "ddsSkyboxVertSrc",
        ),
        ddsFragment: extractPackagedStringLiteral(
            ddsModule,
            "ddsSkyboxFragSrc",
        ),
        hdrFragment: extractPackagedStringLiteral(
            readFileSync(
                resolve(
                    packageRoot,
                    "lib/material/pbr/background-hdr-skybox.js",
                ),
                "utf8",
            ),
            "skyboxHdrFragSrc",
        ),
        dither: readPinnedDitherWgsl(packageRoot),
    };
}

// ---------------------------------------------------------------------------
// Ground
// ---------------------------------------------------------------------------

interface TakenBackgroundFragment {
    /** The pin's texture variable name, kept. */
    texture: string;
    /** The pin's sampler variable name, kept. */
    sampler: string;
    /** The pin's entry parameter name, kept. */
    parameter: string;
    /** The entry body, still the pin's bytes. */
    body: string;
}

function takeBackgroundFragment(
    source: string,
    meshMembers: string,
    varyingMembers: string,
    textureType: string,
    what: string,
): TakenBackgroundFragment {
    // The mesh block is asserted member for member: the re-homing map below is
    // written against exactly these members, so a pin that reshapes the block
    // must fail here, not produce a fragment that reads the wrong offsets.
    const mesh = new RegExp(
        `struct (\\w+)\\{${meshMembers}\\}@group\\(1\\) @binding\\(0\\) var<uniform> mesh:\\1;`,
    ).exec(source);
    if (!mesh) backgroundLiftError(`${what} mesh uniform block`);
    const bindings = new RegExp(
        `@group\\(1\\) @binding\\(1\\) var (\\w+):${textureType};@group\\(1\\) @binding\\(2\\) var (\\w+):sampler;`,
    ).exec(source);
    if (!bindings) backgroundLiftError(`${what} texture bindings`);
    const varying = new RegExp(`struct (\\w+)\\{${varyingMembers}\\}`).exec(
        source,
    );
    if (!varying) backgroundLiftError(`${what} varying block`);
    const entry =
        /@fragment fn main\((\w+):(\w+)\)->@location\(0\) vec4<f32>\{([\s\S]*)\}$/.exec(
            source,
        );
    if (!entry) backgroundLiftError(`${what} entry point`);
    return {
        texture: bindings[1]!,
        sampler: bindings[2]!,
        parameter: entry[1]!,
        body: entry[3]!,
    };
}

/**
 * The pinned ground fragment, taken from `background-ground.ts`'s own
 * `groundFragSrc` and its module-local `WGSL_IMAGE_PROCESSING`, composed the
 * way the pin composes them (`SCENE_UBO_WGSL + WGSL_IMAGE_PROCESSING +
 * dither + groundFragSrc`). The re-homing map is the native flattening:
 *
 * - `mesh.primaryColor`/`mesh.alpha` -> `uniforms.primaryColorAlpha`
 * - `mesh.backgroundCenter`          -> `uniforms.backgroundCenter.xyz`
 * - `scene.vEyePosition.xyz`         -> `uniforms.cameraExposure.xyz`
 * - `scene.vImageInfos.x` (exposure) -> `uniforms.cameraExposure.w`
 * - `scene.vImageInfos.y` (contrast) -> `uniforms.imageParameters.x`
 * - `scene.vImageInfos.w` (+toneMappingEnabled, the pin's own packing) ->
 *   `uniforms.imageParameters.y`, which the plan writes as 1.0 — so the
 *   pinned `>= 0.0` gate holds exactly as it does upstream, where the packed
 *   flag is 0 or 1.
 *
 * The world matrix in the pin's mesh block belongs to its vertex stage; the
 * native ground renders through the shared model vertex stage, so the
 * fragment block carries only what this body reads.
 */
export function backgroundGroundFragmentWgsl(
    provenance: string,
    pinned: PinnedBackgroundGroundSource,
    dither = false,
): string {
    const taken = takeBackgroundFragment(
        pinned.fragment,
        "world:mat4x4<f32>,primaryColor:vec3<f32>,alpha:f32,backgroundCenter:vec3<f32>,_pad:f32",
        "@location\\(0\\) vPositionW:vec3<f32>,@location\\(1\\) vNormalW:vec3<f32>,@location\\(2\\) vUV:vec2<f32>",
        "texture_2d<f32>",
        "ground fragment",
    );
    for (const marker of ["applyImageProcessing(", "dither("]) {
        if (!taken.body.includes(marker)) {
            backgroundLiftError(`ground fragment ('${marker}' is gone)`);
        }
    }
    const body = rehome(
        taken.body,
        [
            ["mesh.primaryColor", "uniforms.primaryColorAlpha.rgb"],
            ["mesh.alpha", "uniforms.primaryColorAlpha.a"],
            ["mesh.backgroundCenter", "uniforms.backgroundCenter.xyz"],
            ["scene.vEyePosition.xyz", "uniforms.cameraExposure.xyz"],
            ["scene.vImageInfos.w", "uniforms.imageParameters.y"],
            [`${taken.parameter}.vPositionW`, `${taken.parameter}.worldPosition`],
            [`${taken.parameter}.vNormalW`, `${taken.parameter}.normal`],
            [`${taken.parameter}.vUV`, `${taken.parameter}.uv`],
        ],
        "ground fragment",
    );
    if (
        !pinned.imageProcessing.includes(
            "fn applyImageProcessing(result: vec4<f32>) -> vec4<f32>",
        )
    ) {
        backgroundLiftError("ground applyImageProcessing declaration");
    }
    const imageProcessing = rehome(
        pinned.imageProcessing.trim(),
        [
            ["scene.vImageInfos.x", "uniforms.cameraExposure.w"],
            ["scene.vImageInfos.y", "uniforms.imageParameters.x"],
        ],
        "ground applyImageProcessing",
    );
    assertFullyRehomed(body, "ground fragment");
    assertFullyRehomed(imageProcessing, "ground applyImageProcessing");
    return `// ${provenance}
${(dither ? pinned.dither.dither : pinned.dither.noDither).trim()}

@group(2) @binding(0) var ${taken.texture}: texture_2d<f32>;
@group(2) @binding(1) var ${taken.sampler}: sampler;

struct GroundUniforms {
    primaryColorAlpha: vec4<f32>,
    backgroundCenter: vec4<f32>,
    cameraExposure: vec4<f32>,
    imageParameters: vec4<f32>,
}
@group(3) @binding(0) var<uniform> uniforms: GroundUniforms;

${fragmentInput()}

${imageProcessing}

@fragment
fn mainFragment(${taken.parameter}: FragmentInput) -> @location(0) vec4<f32> {
${formatStatements(body)}
}
`;
}

// ---------------------------------------------------------------------------
// DDS and HDR cubemap skyboxes
// ---------------------------------------------------------------------------

function skyboxShell(
    provenance: string,
    prefix: string,
    taken: TakenBackgroundFragment,
    body: string,
): string {
    return `// ${provenance}
${prefix}@group(2) @binding(0) var ${taken.texture}: texture_cube<f32>;
@group(2) @binding(1) var ${taken.sampler}: sampler;

struct SkyboxUniforms {
    primaryColorExposure: vec4<f32>,
    backgroundCenter: vec4<f32>,
    imageParameters: vec4<f32>,
}
@group(3) @binding(0) var<uniform> uniforms: SkyboxUniforms;

${fragmentInput()}

@fragment
fn mainFragment(${taken.parameter}: FragmentInput) -> @location(0) vec4<f32> {
${formatStatements(body)}
}
`;
}

/**
 * The DDS vertex stage itself, with only its two uniform owners folded into
 * one native block. Keeping the pin's two varyings is significant: its dither
 * hashes interpolated world position, so baking the translation into CPU
 * vertices changes low interpolation bits and produces unrelated noise.
 */
export function backgroundDdsSkyboxVertexWgsl(
    provenance: string,
    pinned: PinnedBackgroundSkyboxSource,
): string {
    const source = pinned.ddsVertex;
    const declaration =
        /^struct (\w+)\{world:mat4x4<f32>\}@group\(1\) @binding\(0\) var<uniform> mesh:(\w+);/.exec(
            source,
        );
    if (!declaration || declaration[1] !== declaration[2]) {
        backgroundLiftError("DDS skybox vertex mesh uniform block");
    }
    const varying =
        /struct (\w+)\{@builtin\(position\) clipPos:vec4<f32>,@location\(0\) positionUVW:vec3<f32>,@location\(1\) positionW:vec3<f32>\}/.exec(
            source,
        );
    if (!varying) {
        backgroundLiftError("DDS skybox vertex varying block");
    }
    const entry =
        /@vertex fn main\(@location\(0\) (\w+):vec3<f32>\)->(\w+)\{([\s\S]*)\}$/.exec(
            source,
        );
    if (!entry || entry[2] !== varying[1]) {
        backgroundLiftError("DDS skybox vertex entry point");
    }
    const body = rehome(
        entry[3]!,
        [
            [`var a:${varying[1]};`, "var a: VertexOutput;"],
            ["mesh.world", "uniforms.world"],
            ["scene.viewProjection", "uniforms.viewProjection"],
        ],
        "DDS skybox vertex",
    );
    assertFullyRehomed(body, "DDS skybox vertex");
    return `// ${provenance}
struct SkyboxVertexUniforms {
    viewProjection: mat4x4<f32>,
    world: mat4x4<f32>,
}
@group(1) @binding(0) var<uniform> uniforms: SkyboxVertexUniforms;

struct VertexOutput {
    @builtin(position) clipPos: vec4<f32>,
    @location(0) positionUVW: vec3<f32>,
    @location(1) positionW: vec3<f32>,
}

@vertex
fn mainVertex(@location(0) ${entry[1]}: vec3<f32>) -> VertexOutput {
${formatStatements(body)}
}
`;
}

function ddsSkyboxShell(
    provenance: string,
    pinned: PinnedBackgroundSkyboxSource,
    taken: TakenBackgroundFragment,
    body: string,
): string {
    return `// ${provenance}
${pinned.dither.dither.trim()}

@group(2) @binding(0) var ${taken.texture}: texture_cube<f32>;
@group(2) @binding(1) var ${taken.sampler}: sampler;

struct SkyboxUniforms {
    primaryColorExposure: vec4<f32>,
    backgroundCenter: vec4<f32>,
    imageParameters: vec4<f32>,
}
@group(3) @binding(0) var<uniform> uniforms: SkyboxUniforms;

struct FragmentInput {
    @builtin(position) position: vec4<f32>,
    @location(0) positionUVW: vec3<f32>,
    @location(1) positionW: vec3<f32>,
}

@fragment
fn mainFragment(${taken.parameter}: FragmentInput) -> @location(0) vec4<f32> {
${formatStatements(body)}
}
`;
}

/**
 * The direction re-homing both skybox arms share: the pin's `positionUVW` is
 * the cube's local corner, but the shared model vertex stage carries world
 * position, so the plan's `backgroundCenter` subtracts the cube's translation
 * back out (zero for the environment cubemap, which is authored around the
 * origin). `positionW`, where present, is the pin's world position directly.
 */
function skyboxDirection(parameter: string): readonly [string, string] {
    return [
        `${parameter}.positionUVW`,
        `${parameter}.worldPosition-uniforms.backgroundCenter.xyz`,
    ];
}

/**
 * The pinned DDS skybox fragment (`ddsSkyboxFragSrc`), the arm the PALs load
 * as `background-skybox-dither.frag`. Its image-processing block is the pin's
 * own: tone mapping is unconditional inside the gate, the contrast fold
 * carries only the high arm (`mix(a, f, contrast-1.0)`) — the transcription
 * this replaces carried both arms, which diverged below contrast 1.0 — and
 * the dither lands inside the gate, before the final clamp.
 *
 * Re-homing: `mesh.primaryColor` -> `uniforms.primaryColorExposure.rgb`,
 * `mesh.exposureLinear` -> `.a`, `mesh.contrast` ->
 * `uniforms.imageParameters.x`, and `scene.vImageInfos.w`
 * (+toneMappingEnabled upstream, 0 or 1) -> `uniforms.imageParameters.z`,
 * the plan's tone-mapping flag — the pinned `>= 0.0` gate holds for both
 * values on both sides.
 */
function ddsSkyboxFragmentWgsl(
    provenance: string,
    pinned: PinnedBackgroundSkyboxSource,
): string {
    const taken = takeBackgroundFragment(
        pinned.ddsFragment,
        "world:mat4x4<f32>,primaryColor:vec3<f32>,exposureLinear:f32,contrast:f32,_pad1:f32,_pad2:f32,_pad3:f32",
        "@location\\(0\\) positionUVW:vec3<f32>,@location\\(1\\) positionW:vec3<f32>",
        "texture_cube<f32>",
        "DDS skybox fragment",
    );
    if (!taken.body.includes("dither(")) {
        backgroundLiftError("DDS skybox fragment ('dither(' is gone)");
    }
    const body = rehome(
        taken.body,
        [
            ["mesh.primaryColor", "uniforms.primaryColorExposure.rgb"],
            ["mesh.exposureLinear", "uniforms.primaryColorExposure.a"],
            ["mesh.contrast", "uniforms.imageParameters.x"],
            ["scene.vImageInfos.w", "uniforms.imageParameters.z"],
        ],
        "DDS skybox fragment",
    );
    assertFullyRehomed(body, "DDS skybox fragment");
    return ddsSkyboxShell(provenance, pinned, taken, body);
}

/**
 * The pinned HDR (environment cubemap) skybox fragment (`skyboxHdrFragSrc`),
 * the arm the PALs load as `background-skybox.frag`. The pin composes no
 * dither for it, multiplies no primary colour, tone-maps nothing, and folds
 * contrast through both arms unconditionally — so this fragment does exactly
 * that and nothing else.
 */
function hdrSkyboxFragmentWgsl(
    provenance: string,
    pinned: PinnedBackgroundSkyboxSource,
): string {
    const taken = takeBackgroundFragment(
        pinned.hdrFragment,
        "world:mat4x4<f32>,primaryColor:vec3<f32>,_pad:f32,skyOutputColor:vec3<f32>,_pad2:f32,exposureLinear:f32,contrast:f32,_pad3:f32,_pad4:f32",
        "@location\\(0\\) positionUVW:vec3<f32>,@location\\(1\\) positionW:vec3<f32>",
        "texture_cube<f32>",
        "HDR skybox fragment",
    );
    if (taken.body.includes("dither(")) {
        // The PAL loads this file precisely because the pin composes no
        // dither for the environment cubemap; a pin that starts dithering
        // here needs the variant selection redesigned, not silent noise.
        backgroundLiftError("HDR skybox fragment (dither appeared)");
    }
    const body = rehome(
        taken.body,
        [
            ["mesh.exposureLinear", "uniforms.primaryColorExposure.a"],
            ["mesh.contrast", "uniforms.imageParameters.x"],
            skyboxDirection(taken.parameter),
        ],
        "HDR skybox fragment",
    );
    assertFullyRehomed(body, "HDR skybox fragment");
    return skyboxShell(provenance, "", taken, body);
}

/**
 * One generated fragment per pinned skybox arm, under the filenames the PALs
 * already select between: `background-skybox.frag` is the environment-cubemap
 * (HDR) arm and `background-skybox-dither.frag` the DDS arm, keyed on
 * `skybox_uses_environment` exactly as before.
 */
export function backgroundSkyboxFragmentWgsl(
    provenance: string,
    pinned: PinnedBackgroundSkyboxSource,
    dither = false,
): string {
    return dither
        ? ddsSkyboxFragmentWgsl(provenance, pinned)
        : hdrSkyboxFragmentWgsl(provenance, pinned);
}

// ---------------------------------------------------------------------------
// Solid-colour skybox
// ---------------------------------------------------------------------------

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
    /** `shader/wgsl-helpers.ts` `WGSL_DITHER`, which the pin composes first. */
    dither: string;
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
    const body = formatStatements(taken.body).replace(
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
${pinned.dither.trim()}

${solidSkyboxMeshStruct(pinned.fragment)}@group(3) @binding(0) var<uniform> mesh: SolidSkyboxUniforms;

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
${formatStatements(taken.body)}
}
`;
}
