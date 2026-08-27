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
    /**
     * The three group-1 bindings the composed fragment declares per shadow
     * light, in the pin's own allocation order.
     *
     * `node-shadow.ts` continues the GRAPH's own binding run rather than
     * opening a group of its own, which is where the node family differs
     * from the Standard and PBR receivers: `mesh.receiveShadows` is a
     * composition key for those two and the `meshU.receivesShadow` uniform
     * lane for this one, so one composed module serves a receiving mesh and
     * a non-receiving one alike.
     */
    shadowBindings: readonly ComposedNodeShadowBinding[];
    /**
     * The ESM caster module, when the scene casts a shadow from this graph.
     *
     * The pin re-compiles the same bodies with the depth code its own
     * `createNodeEsmShadowMaterialView` carries, so this is a second module
     * rather than a second graph -- `buildNodeRenderables` does exactly this
     * for a view whose feature word carries `NODE_ESM_SHADOW_OUTPUT`.
     */
    esmCaster: ComposedNodeCaster | null;
}

/** One shadow light's bindings, as `emitShadow` allocated them. */
export interface ComposedNodeShadowBinding {
    lightIndex: number;
    texture: number;
    sampler: number;
    ubo: number;
    shadowType: "esm" | "pcf";
    /**
     * The three names the emitter declared them under, checked against the
     * module it produced. SDL_GPU resolves every stage binding by the name
     * its `.slots` sidecar carries, so the names are part of the contract
     * and not a backend's own reconstruction.
     */
    textureName: string;
    samplerName: string;
    uboName: string;
}

/** The ESM caster module and the one binding it adds. */
export interface ComposedNodeCaster {
    wgsl: string;
    /** The group-1 binding `nmeShadowParams` took. */
    paramsBinding: number;
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
        /** One per shadow light, allocated in the graph's own binding run. */
        _shadowBindings: readonly {
            _lightIndex: number;
            _texBinding: number;
            _sampBinding: number;
            _uboBinding: number;
            _shadowType: "esm" | "pcf";
        }[];
    };
    _state: PinnedNodeBuildState;
    /** The emitted bodies, which the caster's second compile re-uses. */
    _vertexBody: string;
    _fragmentBody: string;
    /** The env emitter, present only for a graph that reaches one. */
    _envHelpers?: { emitEnv: unknown };
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
        options: {
            json?: unknown;
            shadowGenerators?: readonly { _shadowType: string }[];
            shadowLightIndices?: readonly number[];
        },
    ) => Promise<PinnedNodeMaterial>;
}

/** The pin's own pipeline builder, for the caster's second compile. */
interface PinnedNodePipelineModule {
    compileNodePipeline: (
        state: unknown,
        vertexBody: string,
        fragmentBody: string,
        options: Record<string, unknown>,
    ) => {
        _wgsl: string;
        _esmShadowParamsBinding: number | null;
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
}

/** The pin's own ESM view, which carries the caster's depth code. */
interface PinnedNodeEsmViewModule {
    createNodeEsmShadowMaterialView: (
        source: unknown,
        shadowParamsUBO: unknown,
    ) => { _esmShadowDepthCode: string };
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
    if (material._graph.needsAlphaBlending) refuse(label, "alpha blending");
    for (const [flag, value] of Object.entries(material._state)) {
        if (typeof value !== "boolean" || !value) continue;
        if (servedFlags.has(flag)) continue;
        refuse(label, refusedFlags[flag] ?? `the pinned build flag '${flag}'`);
    }
}

/**
 * Compose one graph. `label` names it in every refusal.
 *
 * `shadowLights` is what the scene's own `shadowGenerators` resolved to; the
 * pin reads only each generator's `_shadowType`, so a stub carrying that is
 * the whole shape. `castsEsmShadow` asks for the second module the caster
 * pass draws, which the pin builds by re-compiling these same bodies.
 */
export async function composeNodeMaterial(
    json: JsonObject,
    label: string,
    shadowLights: readonly {
        lightIndex: number;
        shadowType: "esm" | "pcf";
    }[] = [],
    castsEsmShadow = false,
): Promise<ComposedNodeMaterial> {
    const module = await importPinnedModule<PinnedNodeMaterialModule>(
        "material/node/node-material.js",
    );
    const engine = compositionEngine();
    const material = await module.parseNodeMaterialFromSnippet(
        engine,
        "",
        {
            json,
            ...(shadowLights.length > 0
                ? {
                      shadowGenerators: shadowLights.map(({ shadowType }) => ({
                          _shadowType: shadowType,
                      })),
                      shadowLightIndices: shadowLights.map(
                          ({ lightIndex }) => lightIndex,
                      ),
                  }
                : {}),
        },
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
    const esmCaster = castsEsmShadow
        ? await composeNodeEsmCaster(material, engine)
        : null;
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
        shadowBindings: material._compile._shadowBindings.map((binding) =>
            shadowBindingNames({
                lightIndex: binding._lightIndex,
                texture: binding._texBinding,
                sampler: binding._sampBinding,
                ubo: binding._uboBinding,
                shadowType: binding._shadowType,
            }, material._compile._wgsl)),
        esmCaster,
    };
}

/**
 * The three declared names of one shadow light's bindings.
 *
 * `emitShadow` suffixes each with the LIGHT's own index and forks the
 * sampler's stem on the filter -- a comparison sampler for PCF, a plain one
 * for ESM. Both halves are checked against the module rather than trusted,
 * so a pin that renames one fails here instead of leaving a backend
 * resolving a name nothing declares.
 */
function shadowBindingNames(
    binding: Omit<
        ComposedNodeShadowBinding,
        "textureName" | "samplerName" | "uboName"
    >,
    wgsl: string,
): ComposedNodeShadowBinding {
    const suffix = `_${binding.lightIndex}`;
    const named = {
        ...binding,
        textureName: `shadowTex${suffix}`,
        samplerName: binding.shadowType === "pcf"
            ? `shadowComp${suffix}`
            : `shadowSamp${suffix}`,
        uboName: `shadowInfo${suffix}`,
    };
    for (const [role, name] of [
        ["texture", named.textureName],
        ["sampler", named.samplerName],
        ["ubo", named.uboName],
    ] as const) {
        if (!wgsl.includes(`var<uniform> ${name}:`) &&
            !wgsl.includes(`var ${name}:`)) {
            throw new Error(
                `The pinned node shadow emitter declared no ${role} named ` +
                    `'${name}'.`,
            );
        }
    }
    return named;
}

/**
 * The ESM caster module for one composed graph.
 *
 * `buildNodeRenderables` re-compiles the material's own bodies whenever its
 * view carries `NODE_ESM_SHADOW_OUTPUT`, with the target state the shadow
 * map is allocated at and the depth code the view holds. Both halves come
 * from the pin: the state is that call's own argument list, and the depth
 * code is `createNodeEsmShadowMaterialView`'s own constant, read by running
 * the factory rather than by copying the string.
 */
async function composeNodeEsmCaster(
    material: PinnedNodeMaterial,
    engine: unknown,
): Promise<ComposedNodeCaster> {
    const pipeline = await importPinnedModule<PinnedNodePipelineModule>(
        "material/node/node-pipeline.js",
    );
    const view = await importPinnedModule<PinnedNodeEsmViewModule>(
        "material/node/esm-shadow-view.js",
    );
    const { _esmShadowDepthCode } = view.createNodeEsmShadowMaterialView(
        material,
        // The buffer is bound at run time, never read while compiling.
        { kind: "buffer" },
    );
    const compiled = pipeline.compileNodePipeline(
        material._state,
        material._vertexBody,
        material._fragmentBody,
        {
            _engine: engine,
            // The shadow map's own format and state, which is what the pin
            // passes here rather than the frame's.
            _format: "rgba16float",
            _depthStencilFormat: "depth32float",
            _depthCompare: "less-equal",
            _msaaSamples: 1,
            _backFaceCulling: material._graph.backFaceCulling,
            _noColorOutput: false,
            _esmShadowOutput: true,
            _esmShadowDepthCode,
            _alphaMode: 0,
            // The shared fragment body still names the env samplers even in
            // the depth variant, so its declarations have to come with it.
            _envEmitter: material._envHelpers?.emitEnv,
        },
    );
    if (compiled._esmShadowParamsBinding === null) {
        throw new Error(
            "The pinned node ESM caster compiled without its shadow-params " +
                "binding.",
        );
    }
    // One bind-group layout serves both views, differing only by the rows
    // above -- the receiver's per-light three against the caster's single
    // params block. That holds only while every OTHER binding the graph
    // declares landed on the same number in both compiles, which is a
    // property of the emission order rather than a guarantee, so it is
    // checked rather than assumed.
    const sharedBindings = (compile: {
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
    }) =>
        JSON.stringify([
            compile._nodeUboBinding,
            compile._textureBindings.map((binding) => [
                binding._name,
                binding._texBinding,
                binding._sampBinding,
            ]),
            compile._envBindings,
        ]);
    if (sharedBindings(compiled) !== sharedBindings(material._compile)) {
        throw new Error(
            "The pinned node ESM caster numbered its shared bindings " +
                "differently from the receiver it was compiled from.",
        );
    }
    const taken = new Set<number>([
        0,
        ...(compiled._nodeUboBinding === null
            ? []
            : [compiled._nodeUboBinding]),
        ...compiled._textureBindings.flatMap((binding) => [
            binding._texBinding,
            binding._sampBinding,
        ]),
        ...(compiled._envBindings
            ? [
                compiled._envBindings._iblTexture,
                compiled._envBindings._iblSampler,
                compiled._envBindings._brdfLUT,
                compiled._envBindings._brdfSampler,
            ]
            : []),
    ]);
    if (taken.has(compiled._esmShadowParamsBinding)) {
        throw new Error(
            "The pinned node ESM caster put its shadow-params block on a " +
                "binding the graph already uses.",
        );
    }
    return {
        wgsl: compiled._wgsl,
        paramsBinding: compiled._esmShadowParamsBinding,
    };
}
