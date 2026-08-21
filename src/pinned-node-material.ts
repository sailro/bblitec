/**
 * Composes a Node Material by running Babylon Lite's own compiler.
 *
 * A node material is a graph, not a shader: `material/node/node-parser.ts`
 * reads the Babylon NME JSON, `node-emitter.ts` walks it from the two output
 * blocks through one emitter per block class, and `node-pipeline.ts` wraps the
 * two bodies into the module the browser compiles. Nothing in that chain is a
 * formula this port could restate — the emitters are the graph's semantics,
 * and the pin ships a hundred and three of them.
 *
 * So the graph is compiled the way the post-process passes are: the pin's own
 * entry point runs under Node against a recording device, and what deploys is
 * the text it produced. The device is reachable only at the very end of
 * `compileNodePipeline`, after the WGSL is assembled, which is why a stub with
 * four methods is enough — and why a pin that started deciding the text from
 * something a real device answers would fail here rather than compose
 * something else.
 *
 * Every arm outside the reached slice is refused by name. The graph decides
 * which arms it reaches, so the refusal is the pin's own build state read back
 * rather than a scan of the JSON — and the flag list is closed, so a pin that
 * adds one refuses rather than composing a module this port cannot serve.
 */
import type { JsonObject } from "./gltf-document.js";
import { importPinnedModule } from "./pinned-shader-composer.js";

/** One vertex input the composed module declares, at its own location. */
export interface ComposedNodeAttribute {
    location: number;
    /** The pin's own attribute name; a PAL maps it onto our vertex. */
    name: string;
}

/**
 * The four group-1 bindings a graph reaching the environment declares.
 *
 * `node-env.ts` allocates them together and binds them from the scene's own
 * `EnvironmentTextures` — the same specular cube and BRDF LUT the material
 * families sample — so the PAL resolves them against what it already holds.
 */
export interface ComposedNodeEnvBindings {
    iblTexture: number;
    iblSampler: number;
    brdfLut: number;
    brdfSampler: number;
}

/**
 * One texture the graph samples, at the pair the pin's pipeline builder gave
 * it.
 *
 * `compileNodePipeline` allocates the pair from the same running binding
 * counter the node UBO and the environment take, so the numbers belong to the
 * composition rather than to any ordering this port could choose. The name is
 * the pin's own sanitized block name, which is also the key `options.textures`
 * is read under, so it is what joins a declared binding to the texture the
 * scene supplied.
 */
export interface ComposedNodeTextureBinding {
    name: string;
    texture: number;
    sampler: number;
}

/** What running the pin's node-material compiler produced. */
export interface ComposedNodeMaterial {
    /** The module both stages compile from, the pin's own text. */
    wgsl: string;
    /** The node UBO's size, from the pin's own `computeUboLayout`. */
    uboBytes: number;
    /** Its group-1 binding, or null when the graph declares no uniform. */
    uboBinding: number | null;
    /**
     * The block's bytes as floats, folded from the graph's own defaults.
     *
     * `writeNodeUBO` scatters each named input's values at the offset the
     * pin's layout gave it, and every reached scene leaves those values
     * alone — the `inputs` handles that would change one are not lowered, so
     * a scene writing one fails by name. That makes the block a constant,
     * and this is what the pin's writer would have written into it.
     */
    uboFloats: readonly number[];
    attributes: readonly ComposedNodeAttribute[];
    /** The texture pairs the graph declares, in the pin's allocation order. */
    textures: readonly ComposedNodeTextureBinding[];
    /** `backFaceCulling` as the graph's JSON declares it. */
    backFaceCulling: boolean;
    /** The environment bindings, or null when the graph reaches none. */
    envBindings: ComposedNodeEnvBindings | null;
}

/** The pin's build state, by the field names `node-types.ts` gives them. */
interface PinnedNodeBuildState {
    vertexAttributes: readonly { _name: string }[];
    shadowLights: readonly unknown[];
    [flag: string]: unknown;
}

interface PinnedNodeMaterial {
    _compile: {
        _wgsl: string;
        _nodeUboSize: number;
        _nodeUboBinding: number | null;
        _textureBindings: readonly {
            _name: string;
            _texBinding: number;
            _sampBinding: number;
        }[];
        _envBindings: {
            _iblTexture: number;
            _iblSampler: number;
            _brdfLUT: number;
            _brdfSampler: number;
        } | null;
    };
    _state: PinnedNodeBuildState;
    _graph: {
        backFaceCulling: boolean;
        needsAlphaBlending: boolean;
    };
    _uniformValues: ReadonlyMap<
        string,
        { _offsetBytes: number; _values: Float32Array }
    >;
}

interface PinnedNodeMaterialModule {
    parseNodeMaterialFromSnippet: (
        engine: unknown,
        snippetId: string,
        options: { json?: unknown },
    ) => Promise<PinnedNodeMaterial>;
}

/**
 * A device that records instead of allocating.
 *
 * `compileNodePipeline` assembles the whole module before it touches one, and
 * the four entry points below are every device call on that path. A descriptor
 * is returned as itself so a caller that wanted to read one still can; nothing
 * in this port does.
 */
function compositionEngine(): unknown {
    const record = (kind: string) => (descriptor: unknown) => ({
        kind,
        descriptor,
    });
    return {
        _device: {
            createShaderModule: record("shaderModule"),
            createBindGroupLayout: record("bindGroupLayout"),
            createPipelineLayout: record("pipelineLayout"),
            createRenderPipeline: record("renderPipeline"),
        },
        // The two the pipeline descriptor reads. The format decides nothing in
        // the text; the sample count reaches the descriptor alone.
        format: "bgra8unorm",
        msaaSamples: 4,
    };
}

/**
 * The build-state flags this port does not serve, and the block that sets
 * each. The set is closed: `assertReachedSlice` refuses any *other* flag the
 * pin raises, so a pin that adds one fails here rather than composing a
 * module with an arm no PAL binds.
 */
const refusedFlags: Readonly<Record<string, string>> = {
    usesMorphTargets: "MorphTargetsBlock",
    usesClipPlanes: "ClipPlanesBlock",
    usesMeshAttributeExists: "MeshAttributeExistsBlock",
};

/**
 * The build-state flags a served graph is allowed to raise.
 *
 * The lights buffer and the environment pair are resources the PAL already
 * holds for the material families. The five layer flags beside them declare
 * nothing at all — `PBRMetallicRoughnessBlock` reads each one to decide which
 * arithmetic to compose, and the resulting module binds the same seven
 * resources either way — so serving the block serves them.
 */
const servedFlags = new Set([
    "hasSkeleton",
    "hasInstances",
    "usesLightsUbo",
    "usesEnv",
    // The screen size rides the block's two spare lanes, which
    // `_packSceneUniforms` fills for every scene.
    "usesScreenSize",
    "usesClearcoat",
    "usesSheen",
    "usesAnisotropy",
    "usesIridescence",
    "usesSubsurface",
    // A graph writing `@builtin(frag_depth)` writes the depth convention
    // itself, so it only composes against a renderer that shares the pin's:
    // `pinned_depth_clear` in the PALs, near -> 1 compared greater-equal.
    "usesFragDepth",
]);

/**
 * The vertex inputs a PAL can serve out of our own vertex. The pin names an
 * attribute where Babylon names it, and the PALs already map these onto
 * `GpuVertex` for the composed material variants — so a graph asking for
 * something else fails here, at generation, naming it.
 */
const supportedAttributes = new Set([
    "position",
    "normal",
    "uv",
    "uv2",
    "color",
    "tangent",
]);

function refuse(label: string, what: string): never {
    throw new Error(
        `Node material '${label}' reaches ${what}, which this prototype ` +
            "does not lower.",
    );
}

/** Refuse every arm outside the reached slice, naming the block. */
function assertReachedSlice(
    material: PinnedNodeMaterial,
    label: string,
): void {
    if (material._state.shadowLights.length > 0) {
        refuse(label, "a shadow generator");
    }
    if (material._graph.needsAlphaBlending) refuse(label, "alpha blending");
    for (const [flag, value] of Object.entries(material._state)) {
        if (typeof value !== "boolean" || !value) continue;
        if (servedFlags.has(flag)) continue;
        refuse(label, refusedFlags[flag] ?? `the pinned build flag '${flag}'`);
    }
}

/** Compose one graph. `label` names it in every refusal. */
export async function composeNodeMaterial(
    json: JsonObject,
    label: string,
): Promise<ComposedNodeMaterial> {
    const module = await importPinnedModule<PinnedNodeMaterialModule>(
        "material/node/node-material.js",
    );
    const material = await module.parseNodeMaterialFromSnippet(
        compositionEngine(),
        "",
        { json },
    );
    assertReachedSlice(material, label);
    const attributes = material._state.vertexAttributes.map(
        (attribute, index) => {
            if (!supportedAttributes.has(attribute._name)) {
                throw new Error(
                    `Node material '${label}' declares the vertex input ` +
                        `'${attribute._name}', which our vertex does not ` +
                        "carry.",
                );
            }
            // The pipeline builder gives each attribute the location of its
            // own index (`state.vertexAttributes.map((a, i) => ...)`), so the
            // location is the position in this list rather than a field.
            return { location: index, name: attribute._name };
        },
    );
    const uboFloats = new Array<number>(
        material._compile._nodeUboSize / 4,
    ).fill(0);
    for (const slot of material._uniformValues.values()) {
        const start = slot._offsetBytes / 4;
        slot._values.forEach((value, index) => {
            uboFloats[start + index] = value;
        });
    }
    const env = material._compile._envBindings;
    return {
        wgsl: material._compile._wgsl,
        uboBytes: material._compile._nodeUboSize,
        uboBinding: material._compile._nodeUboBinding,
        uboFloats,
        attributes,
        textures: material._compile._textureBindings.map((binding) => ({
            name: binding._name,
            texture: binding._texBinding,
            sampler: binding._sampBinding,
        })),
        backFaceCulling: material._graph.backFaceCulling,
        envBindings: env
            ? {
                iblTexture: env._iblTexture,
                iblSampler: env._iblSampler,
                brdfLut: env._brdfLUT,
                brdfSampler: env._brdfSampler,
            }
            : null,
    };
}
