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
import type {
    CompiledNodeMaterial,
    NodeMaterialBlockEmitter,
} from "./compiler/types.js";
import type { PinnedGeometryTaskRequest } from "./pinned-material-arms.js";
import {
    geometryAttachmentTypes,
    importPinnedModule,
    importPinnedModuleWithExports,
} from "./pinned-shader-composer.js";
import { LoweringContext } from "./lowering/context.js";
import { sharedUpstreamStore } from "./upstream-source.js";

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
 * The two group-1 read-only storage bindings a graph reaching
 * `MorphTargetsBlock` declares.
 *
 * The deltas and the count/vertex-count/weights payload are already owned by
 * each native mesh. Only their binding numbers come from composition: the
 * pin allocates them after the node UBO and texture pairs, so neither PAL may
 * infer fixed slots for them.
 */
export interface ComposedNodeMorphBindings {
    deltas: number;
    weights: number;
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
    /** Public input handles, as the actual pinned factory exposes them. */
    inputs: readonly { name: string; type: string }[];
    /** `backFaceCulling` as the graph's JSON declares it. */
    backFaceCulling: boolean;
    /** Whether the graph selects BJS alpha-combine mode for its draw. */
    alphaBlending: boolean;
    /** The environment bindings, or null when the graph reaches none. */
    envBindings: ComposedNodeEnvBindings | null;
    /** The morph storage pair, or null when the graph reaches no morph block. */
    morphBindings: ComposedNodeMorphBindings | null;
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
    /** The graph's one native caster module, or none for a receiver only. */
    caster: ComposedNodeCaster | null;
    /** One geometry-output module per task the graph is drawn in. */
    geometryViews: readonly ComposedNodeGeometryView[];
}

/**
 * One shadow light's bindings, as `emitShadow` allocated them.
 *
 * The NUMBERS only: what each one is called, what type it carries and which
 * stages read it are the composed module's own answers, reflected out of it
 * where the rows are emitted.
 */
export interface ComposedNodeShadowBinding {
    lightIndex: number;
    texture: number;
    sampler: number;
    ubo: number;
    shadowType: "esm" | "pcf";
}

/** The ESM caster module and the one binding it adds. */
export type ComposedNodeCaster =
    | {
          kind: "esm";
          wgsl: string;
          /** The group-1 binding `nmeShadowParams` took. */
          paramsBinding: number;
      }
    | {
          kind: "pcf";
          /** NODE_NO_COLOR_OUTPUT: depth only, with no caster-only binding. */
          wgsl: string;
      };

/**
 * One geometry-output view of a graph: a THIRD module of the same source.
 *
 * `node-geometry-view.ts` wraps the parsed material in a view carrying one
 * task's attachment list, and `node-geometry-renderable.ts` emits the graph
 * again from its `GeometryTextureOutputBlock` terminal — so the vertex inputs,
 * the texture pairs and the uniform block are the GEOMETRY emit's own and need
 * not match the colour view's. The probe over scene 149's graph reads
 * `[uv, position]` on the colour view and `[position, normal, uv]` here.
 */
export interface ComposedNodeGeometryView {
    /** The task's index in the manifest's `geometryOutputTasks` order. */
    taskIndex: number;
    /** The module both stages compile from, the pin's own text. */
    wgsl: string;
    uboBytes: number;
    uboBinding: number | null;
    /** The block as `ensureGeometryNodeUBO` filled it, recorded. */
    uboFloats: readonly number[];
    attributes: readonly ComposedNodeAttribute[];
    textures: readonly ComposedNodeTextureBinding[];
    /**
     * `NmeGeomParams`' group-1 binding, or null for a view that needs none.
     *
     * `_needsGpUbo` is raised only by a NORMALIZED_VIEW_DEPTH attachment whose
     * value the graph leaves to the pin's own world-position fallback, so it
     * is a property of the attachment list and the graph together.
     */
    geometryParamsBinding: number | null;
    /** The colour targets the composed `FragmentOutput` writes. */
    colorTargetCount: number;
}

export interface ComposeNodeMaterialOptions {
    shadowLights?: readonly {
        lightIndex: number;
        shadowType: "esm" | "pcf" | "csm";
    }[];
    castsEsmShadow?: boolean;
    blockEmitters?: readonly NodeMaterialBlockEmitter[] | undefined;
    pinnedBlockLoader?: CompiledNodeMaterial["pinnedBlockLoader"];
    castsPcfShadow?: boolean;
    /**
     * The geometry-output tasks this graph is drawn in, in manifest order.
     *
     * A geometry task draws every mesh the scene admits, so a graph reached by
     * one composes a view per task exactly as the PBR family composes an MRT
     * variant per task.
     */
    geometryTasks?: readonly PinnedGeometryTaskRequest[];
}

/**
 * The bindings a compiled node stage pair declares beside its mesh block.
 *
 * Declared once because three sites read it: the receiver's own compile, the
 * caster's, and the check that the two agree.
 */
interface PinnedNodeCompiledBindings {
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
    _morphBindings: {
        _deltasBinding: number;
        _uboBinding: number;
    } | null;
}

/** Bindings that must keep the same numbers in receiver and caster modules. */
function nodeSharedBindings(
    compile: PinnedNodeCompiledBindings,
): readonly (readonly [string, number])[] {
    return [
        ...(compile._nodeUboBinding === null
            ? []
            : [["nodeU", compile._nodeUboBinding] as const]),
        ...compile._textureBindings.flatMap((binding) => [
            [`${binding._name}.texture`, binding._texBinding] as const,
            [`${binding._name}.sampler`, binding._sampBinding] as const,
        ]),
        ...(compile._envBindings
            ? ([
                ["env.ibl", compile._envBindings._iblTexture],
                ["env.iblSampler", compile._envBindings._iblSampler],
                ["env.brdf", compile._envBindings._brdfLUT],
                ["env.brdfSampler", compile._envBindings._brdfSampler],
            ] as const)
            : []),
        ...(compile._morphBindings
            ? ([
                ["morph.deltas", compile._morphBindings._deltasBinding],
                ["morph.weights", compile._morphBindings._uboBinding],
            ] as const)
            : []),
    ];
}

function assertCasterBindingsMatch(
    receiver: PinnedNodeCompiledBindings,
    caster: PinnedNodeCompiledBindings,
    kind: "ESM" | "PCF",
): readonly (readonly [string, number])[] {
    const casterBindings = nodeSharedBindings(caster);
    if (
        JSON.stringify(casterBindings) !==
        JSON.stringify(nodeSharedBindings(receiver))
    ) {
        throw new Error(
            `The pinned node ${kind} caster numbered its shared bindings ` +
                "differently from the receiver it was compiled from.",
        );
    }
    return casterBindings;
}

/** The pin's build state, by the field names `node-types.ts` gives them. */
interface PinnedNodeBuildState {
    vertexAttributes: readonly { _name: string }[];
    [flag: string]: unknown;
}

interface PinnedNodeMaterial {
    _compile: PinnedNodeCompiledBindings & {
        _wgsl: string;
        _nodeUboSize: number;
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
        alphaMode: number;
    };
    _uniformValues: ReadonlyMap<
        string,
        { _offsetBytes: number; _values: Float32Array }
    >;
    inputs: Readonly<Record<string, { type: string }>>;
}

interface PinnedNodeMaterialModule {
    parseNodeMaterialFromSnippet: (
        engine: unknown,
        snippetId: string,
        options: {
            json?: unknown;
            shadowGenerators?: readonly { _shadowType: string }[];
            shadowLightIndices?: readonly number[];
            blockLoader?: (className: string) => Promise<unknown>;
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
    ) => PinnedNodeCompiledBindings & {
        _wgsl: string;
        _esmShadowParamsBinding: number | null;
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
 * The pin's geometry view factory and the three module-local helpers behind
 * it.
 *
 * `node-geometry-view.ts` exports only the factory, and the renderable exports
 * only the per-mesh builder — the resource emit, the compile and the uniform
 * block are module-local, which is exactly what
 * `importPinnedModuleWithExports` exists for. Re-deriving any of the three
 * would be re-deriving the graph's semantics.
 */
interface PinnedNodeGeometryViewModule {
    createNodeGeometryMaterialView: (
        source: unknown,
        config: {
            attachments: readonly number[];
            emitColor: boolean;
            gpUBO: unknown;
            reverseCulling: boolean;
            camera: unknown;
        },
    ) => unknown;
}

interface PinnedNodeGeometryResources {
    _geomState: PinnedNodeBuildState;
    _attrNames: readonly string[];
    _needsGpUbo: boolean;
}

interface PinnedNodeGeometryCompile extends PinnedNodeCompiledBindings {
    _wgsl: string;
    _nodeUboSize: number;
    _geometryGpBinding: number | null;
}

interface PinnedNodeGeometryRenderableModule {
    ensureGeometryResources: (view: unknown) => PinnedNodeGeometryResources;
    ensureGeometryCompile: (
        view: unknown,
        resources: PinnedNodeGeometryResources,
        engine: unknown,
        signature: {
            _colorFormats: readonly string[];
            _depthStencilFormat: string;
            _depthCompare: string;
            _sampleCount: number;
        },
    ) => PinnedNodeGeometryCompile;
    ensureGeometryNodeUBO: (
        resources: PinnedNodeGeometryResources,
        compile: PinnedNodeGeometryCompile,
        engine: unknown,
        source: unknown,
    ) => unknown;
}

/** The pin's own per-attachment default target format. */
interface PinnedGeometryFormatsModule {
    GEOMETRY_TEXTURE_DESCRIPTIONS: readonly { defaultFormat: string }[];
}

interface PinnedNodeParserModule {
    findBlockByClassName: (graph: unknown, className: string) => unknown;
}

/** The queue writes a recording device hands back to its caller. */
interface RecordedBufferWrite {
    offset: number;
    data: Float32Array;
}

/** A recording device, plus the writes the pin asked it to make. */
interface CompositionEngine {
    engine: unknown;
    writes: RecordedBufferWrite[];
}

/**
 * A device that records instead of allocating.
 *
 * `compileNodePipeline` assembles the whole module before it touches one, and
 * the first four entry points below are every device call on that path. A
 * descriptor is returned as itself so a caller that wanted to read one still
 * can; nothing in this port does.
 *
 * The buffer pair beside them is for the geometry view's uniform block:
 * `ensureGeometryNodeUBO` scatters the graph's values into a scratch array and
 * hands it to `queue.writeBuffer`, so recording that call is what makes the
 * block the pin's own bytes rather than a scatter restated here. Nothing on
 * the colour or caster paths reaches either.
 */
function compositionEngine(): CompositionEngine {
    const record = (kind: string) => (descriptor: unknown) => ({
        kind,
        descriptor,
    });
    const writes: RecordedBufferWrite[] = [];
    return {
        writes,
        engine: {
            _device: {
                createShaderModule: record("shaderModule"),
                createBindGroupLayout: record("bindGroupLayout"),
                createPipelineLayout: record("pipelineLayout"),
                createRenderPipeline: record("renderPipeline"),
                createBuffer: record("buffer"),
                queue: {
                    writeBuffer: (
                        _buffer: unknown,
                        offset: number,
                        data: Float32Array,
                    ): void => {
                        writes.push({ offset, data });
                    },
                },
            },
            // The two the pipeline descriptor reads. The format decides
            // nothing in the text; the sample count reaches the descriptor
            // alone.
            format: "bgra8unorm",
            msaaSamples: 4,
        },
    };
}

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
    // The two storage bindings are reflected from `_morphBindings`; both
    // PALs bind the direct mesh morph buffers or their zero-target fallback.
    "usesMorphTargets",
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
    // `ClipPlanesBlock` reads `sceneU.clipPlane`, which is a lane of the
    // pin's own scene block -- packed for every scene from the record
    // `setClipPlane` writes, so serving the block declares no resource.
    "usesClipPlanes",
    // `MeshAttributeExistsBlock` reads the mesh block's spare
    // `receivesShadow` lanes rather than composing a per-mesh variant:
    // "Babylon Lite batches meshes that share the same NME pipeline, so
    // the equivalent decision is a per-mesh uniform flag written beside
    // the world matrix." Both PALs fill those lanes from the geometry's
    // own attribute presence, so one composed module draws a mesh with an
    // attribute and one without.
    "usesMeshAttributeExists",
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

/**
 * Refuse every build flag outside the served set, naming it.
 *
 * One build state per emitted view: `emitGraph` runs again from the geometry
 * terminal, so a graph whose colour arm stays inside the slice can still raise
 * a flag on its geometry arm, and each state is checked where it is produced.
 */
function assertServedBuildFlags(
    state: PinnedNodeBuildState,
    label: string,
): void {
    for (const [flag, value] of Object.entries(state)) {
        if (typeof value !== "boolean" || !value) continue;
        if (servedFlags.has(flag)) continue;
        refuse(label, `the pinned build flag '${flag}'`);
    }
}

/** Refuse every arm outside the reached slice, naming the block. */
function assertReachedSlice(
    material: PinnedNodeMaterial,
    label: string,
): void {
    if (
        material._graph.needsAlphaBlending &&
        material._graph.alphaMode !== 2
    ) {
        refuse(
            label,
            `alpha mode ${material._graph.alphaMode}; only BJS ` +
                "alpha-combine mode 2 is lowered",
        );
    }
    assertServedBuildFlags(material._state, label);
}

/**
 * The vertex inputs one compiled view declares, at the locations the pin's
 * own pipeline builder gave them.
 *
 * `buildVertexIn` numbers them `state.vertexAttributes.map((a, i) => ...)`, so
 * the location is the position in the list rather than a field — and the same
 * list is what `_vertexBuffers` and both PALs' vertex layouts are built from.
 */
function composedAttributes(
    names: readonly string[],
    label: string,
): readonly ComposedNodeAttribute[] {
    return names.map((name, index) => {
        if (!supportedAttributes.has(name)) {
            throw new Error(
                `Node material '${label}' declares the vertex input ` +
                    `'${name}', which our vertex does not carry.`,
            );
        }
        return { location: index, name };
    });
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
    options: ComposeNodeMaterialOptions = {},
): Promise<ComposedNodeMaterial> {
    const {
        shadowLights = [],
        castsEsmShadow = false,
        blockEmitters = [],
        pinnedBlockLoader,
        castsPcfShadow = false,
        geometryTasks = [],
    } = options;
    // `emitShadow` types its slots `"esm" | "pcf"` and forks on
    // `shadowType === "pcf"`, so a cascaded slot would silently take the
    // ESM arm -- a float map and a plain sampler against a generator that
    // renders a comparison-sampled depth array. The node family has no CSM
    // arm upstream, so a graph receiving from one refuses by name.
    const csm = shadowLights.find((slot) => slot.shadowType === "csm");
    if (csm) {
        throw new Error(
            `Node material '${label}' receives from the cascaded shadow ` +
                `generator on light ${csm.lightIndex}. ` +
                "`material/node/node-shadow.ts#emitShadow` carries only " +
                "the ESM and PCF arms, and would compose the ESM one for " +
                "a cascaded slot.",
        );
    }
    const module = await importPinnedModule<PinnedNodeMaterialModule>(
        "material/node/node-material.js",
    );
    const device = compositionEngine();
    const engine = device.engine;
    if (pinnedBlockLoader && blockEmitters.length > 0) {
        throw new Error("A node material cannot combine pinned and closed block loaders.");
    }
    const emitterModules = new Map(
        blockEmitters.map(({ className, module }) => [className, module]),
    );
    const blockLoader = pinnedBlockLoader === "geometry"
        ? (await importPinnedModule<{
              loadNodeBlockEmitterWithGeometry(className: string): Promise<unknown>;
          }>("material/node/node-geometry-block-loader.js")).loadNodeBlockEmitterWithGeometry
        : blockEmitters.length > 0
        ? async (className: string): Promise<unknown> => {
              const emitterModule = emitterModules.get(className);
              if (!emitterModule) {
                  throw new Error(
                      `NodeMaterial: custom block loader has no emitter ` +
                          `for block "${className}"`,
                  );
              }
              const imported = await importPinnedModule<unknown>(
                  emitterModule,
              );
              if (
                  typeof imported !== "object" ||
                  imported === null ||
                  !("emitter" in imported) ||
                  imported.emitter === undefined
              ) {
                  throw new Error(
                      `NodeMaterial: pinned block module '${emitterModule}' ` +
                          "does not export 'emitter'.",
                  );
              }
              return imported.emitter;
          }
        : undefined;
    const material = await module.parseNodeMaterialFromSnippet(
        engine,
        "",
        {
            json,
            ...(blockLoader ? { blockLoader } : {}),
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
    const attributes = composedAttributes(
        material._state.vertexAttributes.map(({ _name }) => _name),
        label,
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
    const morph = material._compile._morphBindings;
    if (castsEsmShadow && castsPcfShadow) {
        throw new Error(
            `Node material '${label}' cannot serve both ESM and PCF caster views.`,
        );
    }
    const caster = castsEsmShadow
        ? await composeNodeEsmCaster(material, engine)
        : castsPcfShadow
          ? await composeNodePcfCaster(material, engine)
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
        inputs: Object.entries(material.inputs).map(([name, input]) => ({ name, type: input.type })),
        backFaceCulling: material._graph.backFaceCulling,
        alphaBlending: material._graph.needsAlphaBlending,
        envBindings: env
            ? {
                iblTexture: env._iblTexture,
                iblSampler: env._iblSampler,
                brdfLut: env._brdfLUT,
                brdfSampler: env._brdfSampler,
            }
            : null,
        morphBindings: morph
            ? {
                deltas: morph._deltasBinding,
                weights: morph._uboBinding,
            }
            : null,
        shadowBindings: material._compile._shadowBindings.map((binding) => ({
            lightIndex: binding._lightIndex,
            texture: binding._texBinding,
            sampler: binding._sampBinding,
            ubo: binding._uboBinding,
            shadowType: binding._shadowType,
        })),
        caster,
        geometryViews: await composeNodeGeometryViews(
            material,
            device,
            label,
            geometryTasks,
        ),
    };
}

/**
 * The geometry-output modules for one graph, one per task it is drawn in.
 *
 * Every step is the pin's own: `createNodeGeometryMaterialView` builds the
 * view, `ensureGeometryResources` emits the graph again from its
 * `GeometryTextureOutputBlock` terminal and assembles the `FragmentOutput`
 * struct and its per-attachment writes, `ensureGeometryCompile` runs the same
 * `compileNodePipeline` the colour view runs with the MRT output attached, and
 * `ensureGeometryNodeUBO` fills the block. Nothing between the graph and the
 * module is restated here.
 */
async function composeNodeGeometryViews(
    material: PinnedNodeMaterial,
    device: CompositionEngine,
    label: string,
    tasks: readonly PinnedGeometryTaskRequest[],
): Promise<readonly ComposedNodeGeometryView[]> {
    if (tasks.length === 0) return [];
    const [view, renderable, types, parser] = await Promise.all([
        importPinnedModule<PinnedNodeGeometryViewModule>(
            "material/node/node-geometry-view.js",
        ),
        importPinnedModuleWithExports<PinnedNodeGeometryRenderableModule>(
            "material/node/node-geometry-renderable.js",
            [
                "ensureGeometryResources",
                "ensureGeometryCompile",
                "ensureGeometryNodeUBO",
            ],
        ),
        importPinnedModule<PinnedGeometryFormatsModule>(
            "frame-graph/geometry-types.js",
        ),
        importPinnedModule<PinnedNodeParserModule>(
            "material/node/node-parser.js",
        ),
    ]);
    // The terminal the geometry emit walks from. `ensureGeometryResources`
    // refuses a graph without one, but only as a bare pinned error code, and
    // a scene that pointed a geometry task at an ordinary node material
    // deserves to be told which graph and which terminal.
    if (
        !parser.findBlockByClassName(
            material._graph,
            "GeometryTextureOutputBlock",
        )
    ) {
        throw new Error(
            `Node material '${label}' is drawn by a geometry-output task but ` +
                "declares no `GeometryTextureOutputBlock`, which is the " +
                "terminal `material/node/node-geometry-renderable.ts` " +
                "`ensureGeometryResources` emits the geometry view from.",
        );
    }
    const composed: ComposedNodeGeometryView[] = [];
    for (const task of tasks) {
        const viewLabel = `${label} geometry ${task.index}`;
        if (task.emitColor) {
            throw new Error(
                `Node material '${label}' is drawn by geometry task ` +
                    `${task.index}, which carries a targetTexture. ` +
                    "`material/node/node-geometry-view.ts` " +
                    "`createNodeGeometryMaterialView` refuses `emitColor`: " +
                    "the node geometry view composes no trailing colour " +
                    "attachment.",
            );
        }
        const attachments = await geometryAttachmentTypes(task.attachments);
        const geometryView = view.createNodeGeometryMaterialView(material, {
            attachments,
            emitColor: false,
            // Read only when the pin builds a real bind group, which this
            // never does; `ensureGeometryCompile` allocates the binding from
            // `_needsGpUbo` alone.
            gpUBO: { kind: "buffer" },
            // Both are geometry-task config the compiler refuses today
            // (`compileGeometryTaskOptions` accepts name, samples,
            // textureDescriptions, targetTexture and targetTextureClearColor
            // only), so this is what the pin would have been handed.
            reverseCulling: false,
            camera: null,
        });
        let resources: PinnedNodeGeometryResources;
        try {
            resources = renderable.ensureGeometryResources(geometryView);
        } catch (error) {
            throw new Error(
                `The pinned node geometry view refuses graph '${label}': ` +
                    "`material/node/node-geometry-renderable.ts` " +
                    "`ensureGeometryResources` composes no morph-target, " +
                    "environment or shadow-receiving geometry arm. The pin " +
                    `raised: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
            );
        }
        assertServedBuildFlags(resources._geomState, viewLabel);
        const compile = renderable.ensureGeometryCompile(
            geometryView,
            resources,
            device.engine,
            {
                // The task's own attachment formats, read from the pin's
                // table exactly as `createGeometryRendererTask` reads it. A
                // per-description `format` override reaches the recorded
                // pipeline descriptor only, so it is not carried here; the
                // composed text is the same either way, and one module is
                // composed per (graph, task) so nothing shares a compile.
                _colorFormats: attachments.map(
                    (type) =>
                        types.GEOMETRY_TEXTURE_DESCRIPTIONS[type]!
                            .defaultFormat,
                ),
                // The task's own depth target, which
                // `createGeometryRendererTask` allocates at `depth32float`
                // for a task carrying no `depthTexture` -- the only shape
                // the compiler lowers. It reaches the descriptor alone.
                _depthStencilFormat: "depth32float",
                _depthCompare: "greater-equal",
                _sampleCount: 4,
            },
        );
        // `ensureGeometryNodeUBO` scatters each named input's live value, or
        // the graph's own default when the scene never touched it, at the
        // offsets THIS compile's layout gave them -- which are not the colour
        // view's. Running it against the recording device is what makes the
        // block the pin's bytes.
        device.writes.length = 0;
        renderable.ensureGeometryNodeUBO(
            resources,
            compile,
            device.engine,
            material,
        );
        const written = device.writes;
        const expected = compile._nodeUboSize > 0 ? 1 : 0;
        if (
            written.length !== expected ||
            (written[0] !== undefined &&
                (written[0].offset !== 0 ||
                    written[0].data.length * 4 !== compile._nodeUboSize))
        ) {
            throw new Error(
                `The pinned node geometry uniform block for '${viewLabel}' ` +
                    "is no longer one write of the whole block, which is " +
                    "what this port reads it back as.",
            );
        }
        const uboFloats = [...(written[0]?.data ?? [])];
        composed.push({
            taskIndex: task.index,
            wgsl: compile._wgsl,
            uboBytes: compile._nodeUboSize,
            uboBinding: compile._nodeUboBinding,
            uboFloats,
            attributes: composedAttributes(resources._attrNames, viewLabel),
            textures: compile._textureBindings.map((binding) => ({
                name: binding._name,
                texture: binding._texBinding,
                sampler: binding._sampBinding,
            })),
            geometryParamsBinding: compile._geometryGpBinding,
            colorTargetCount: attachments.length,
        });
    }
    return composed;
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
    // The same untyped-bag hazard `createPbrComposer`'s dependencies carry:
    // a member the pin renames is ignored here and takes its default there,
    // silently. Checked against the pinned interface's own members, so a
    // renamed `_esmShadowDepthCode` fails rather than composing a caster
    // with no depth code.
    const casterOptions = {
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
    };
    new LoweringContext(sharedUpstreamStore()).assertSuppliedOptions(
        "src/material/node/node-pipeline.ts",
        "CompileOpts",
        Object.keys(casterOptions),
    );
    const compiled = pipeline.compileNodePipeline(
        material._state,
        material._vertexBody,
        material._fragmentBody,
        casterOptions,
    );
    if (compiled._esmShadowParamsBinding === null) {
        throw new Error(
            "The pinned node ESM caster compiled without its shadow-params " +
                "binding.",
        );
    }
    // One bind-group layout serves both views, differing only by the rows
    // the two do not share -- the receiver's per-light three against the
    // caster's single params block. That holds only while every OTHER
    // binding the graph declares landed on the same number in both
    // compiles, and while the params block landed on none of them: both are
    // properties of the pin's emission order rather than guarantees, so
    // both are checked.
    const casterShared = assertCasterBindingsMatch(
        material._compile,
        compiled,
        "ESM",
    );
    // Binding 0 is the mesh block, which neither list carries.
    if (
        compiled._esmShadowParamsBinding === 0 ||
        casterShared.some(([, binding]) =>
            binding === compiled._esmShadowParamsBinding
        )
    ) {
        throw new Error(
            "The pinned node ESM caster put its shadow-params block on a " +
                "binding the graph already uses.",
        );
    }
    return {
        kind: "esm",
        wgsl: compiled._wgsl,
        paramsBinding: compiled._esmShadowParamsBinding,
    };
}

/** The pin's NODE_NO_COLOR_OUTPUT compile used by a PCF depth task. */
async function composeNodePcfCaster(
    material: PinnedNodeMaterial,
    engine: unknown,
): Promise<ComposedNodeCaster> {
    const pipeline = await importPinnedModule<PinnedNodePipelineModule>(
        "material/node/node-pipeline.js",
    );
    const casterOptions = {
        _engine: engine,
        _format: "bgra8unorm",
        _depthStencilFormat: "depth32float",
        _depthCompare: "less-equal",
        _msaaSamples: 1,
        _backFaceCulling: material._graph.backFaceCulling,
        _noColorOutput: true,
        _esmShadowOutput: false,
        _esmShadowDepthCode: undefined,
        _alphaMode: undefined,
        _envEmitter: material._envHelpers?.emitEnv,
    };
    new LoweringContext(sharedUpstreamStore()).assertSuppliedOptions(
        "src/material/node/node-pipeline.ts",
        "CompileOpts",
        Object.keys(casterOptions),
    );
    const compiled = pipeline.compileNodePipeline(
        material._state,
        material._vertexBody,
        material._fragmentBody,
        casterOptions,
    );
    if (compiled._esmShadowParamsBinding !== null) {
        throw new Error(
            "The pinned node PCF caster unexpectedly allocated an ESM shadow-params binding.",
        );
    }
    assertCasterBindingsMatch(material._compile, compiled, "PCF");
    return { kind: "pcf", wgsl: compiled._wgsl };
}
