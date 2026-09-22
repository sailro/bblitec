/**
 * Material plugins, composed through the pin's own bridges.
 *
 * A `MaterialPlugin` is the public, opt-in way to layer custom WGSL onto a
 * built-in PBR or Standard material while keeping the whole lighting
 * pipeline (`docs/lite/architecture/26-material-plugin.md`). Upstream keeps
 * the family behind one call: `enableMaterialPlugins(scene)` registers
 * `pbrPluginExt` and `stdPluginExt` into the two global extension
 * registries, and the pre-existing hook loops in the PBR composer and the
 * Standard renderable then carry the plugin with no shared-code change at
 * all. That call is the boundary this port reaches the feature at too, so a
 * scene that never makes it composes exactly what it composed before.
 *
 * Nothing about the composition is reimplemented here. `buildPluginFragment`
 * turns a plugin list into one `ShaderFragment` — mapping each injection
 * point onto the template slot it belongs at, concatenating several plugins
 * into one slot — and both bridges assign a per-signature index that rides
 * the host material's feature bits so every compose and pipeline cache
 * rebuilds on a plugin change. Both are the pin's own code, executed. What
 * this module owns is the plain-data plugin the scene's own declaration
 * folded to, and the one question generation has to answer that upstream
 * answers with a mesh walk: which index the Standard bridge assigned, so the
 * generated feature derivation can OR the same bits out of the record.
 *
 * Source plugins carry constant shader declarations and dynamic texture/UBO
 * callbacks. The PBR vertex opt-in executes its own pinned bridge; Standard
 * retains fragment texture plugins. Priority and enabled-state mutation refuse.
 */
import ts from "typescript";
import { importPinnedModule } from "./pinned-shader-composer.js";
import { LoweringContext } from "./lowering/context.js";
import { sharedUpstreamStore } from "./upstream-source.js";

/** The pinned module the Standard bridge keeps its index layout in. */
const STD_PLUGIN_BRIDGE = "src/material/plugin/std-plugin-bridge.ts";

/** The mesh hook contributes presence; the material keeps a separate signature index. */
export function pinnedPluginPresenceBit(context: LoweringContext): number {
    const file = context.sourceFile(STD_PLUGIN_BRIDGE);
    const bridge = context.variableInitializer(file, "stdPluginExt");
    if (!ts.isObjectLiteralExpression(bridge))
        return context.contractError(
            bridge,
            "Expected the Standard plugin extension.",
        );
    context.assertExpressionShape(
        context.propertyInitializer(bridge, "_meshFeatures"),
        "(_meshFeatures, mat) => (mat?._pi ? HAS_STD_PLUGINS : 0)",
        "Standard plugin presence hook",
    );
    return context.numericValue(
        context.variableInitializer(file, "HAS_STD_PLUGINS"),
        file,
    );
}

/**
 * One `PluginSamplerDecl` a plugin's `getSamplers()` returns, folded.
 *
 * The two optional halves are the pin's own optional fields, kept optional
 * here for the same reason `buildPluginFragment` defaults them: an absent
 * one composes the default, and stating it would make a plugin that omits
 * it sign differently from one that writes the default out.
 */
export interface MaterialPluginSamplerManifest {
    /** The WGSL name the composed fragment samples the texture through. */
    texture: string;
    /** The WGSL name of the sampler beside it. */
    sampler: string;
    textureType?: string;
    samplerType?: string;
    visibility?: "vertex" | "fragment" | "vertex-fragment";
    depthTexture?: boolean;
}

export interface MaterialPluginUniformManifest {
    name: string;
    type: string;
    visibility?: "vertex" | "fragment" | "vertex-fragment";
}

export interface MaterialPluginVaryingManifest {
    name: string;
    type: string;
}

/** One `MaterialPlugin` object literal, folded from the scene's own AST. */
export interface MaterialPluginManifest {
    /** The plugin's own `name`, which heads its signature upstream. */
    name: string;
    /**
     * `getCustomCode("fragment")`, folded: injection point to WGSL. Absent
     * where the pinned call returns null.
     */
    fragment?: Readonly<Record<string, string>>;
    /** `getCustomCode("vertex")`, folded the same way. */
    vertex?: Readonly<Record<string, string>>;
    /**
     * `getSamplers()`, folded: the texture and sampler pairs the composed
     * fragment declares, in the order `buildPluginFragment` emits them —
     * which is also the order `bindPluginTextures` pushes their resources.
     */
    samplers?: readonly MaterialPluginSamplerManifest[];
    defines?: Readonly<Record<string, string | number | boolean>>;
    uniforms?: readonly MaterialPluginUniformManifest[];
    varyings?: readonly MaterialPluginVaryingManifest[];
}

/** The shape the pin's own bridges read a plugin through. */
interface PinnedPlugin {
    readonly name: string;
    getCustomCode(
        shaderType: "vertex" | "fragment",
    ): Readonly<Record<string, string>> | null;
    getSamplers?(): readonly MaterialPluginSamplerManifest[];
    readonly defines?: Readonly<Record<string, string | number | boolean>>;
    getUniforms?(): { ubo: readonly MaterialPluginUniformManifest[] };
    getVaryings?(): readonly MaterialPluginVaryingManifest[];
}

/**
 * The folded manifest as the object the pin reads.
 *
 * `pluginSignature` and `buildPluginFragment` call `getCustomCode` and
 * `getSamplers` and nothing else on a plugin declaring no uniforms, so the
 * pin sees the scene's own declaration through a closure over the folded
 * records rather than through a second implementation of it. `getSamplers`
 * is defined only when the scene declared it, because `pluginSignature`
 * cannot tell a plugin that has no such member from one whose member
 * returns nothing — but `buildPluginFragment` can, and this port's own
 * list key mirrors the same absence.
 */
function pinnedPlugin(manifest: MaterialPluginManifest): PinnedPlugin {
    const samplers = manifest.samplers;
    return {
        name: manifest.name,
        getCustomCode(shaderType) {
            const code =
                shaderType === "fragment" ? manifest.fragment : manifest.vertex;
            return code ?? null;
        },
        ...(samplers ? { getSamplers: () => samplers } : {}),
        ...(manifest.defines ? { defines: manifest.defines } : {}),
        ...(manifest.uniforms
            ? { getUniforms: () => ({ ubo: manifest.uniforms! }) }
            : {}),
        ...(manifest.varyings ? { getVaryings: () => manifest.varyings! } : {}),
    };
}

/**
 * The identity two plugin lists share a composed fragment under.
 *
 * The pin's own `pluginSignature` is the authority, and it is what
 * `registerPluginBridges` checks the numbering against. The compiler needs
 * its own key because it partitions the scene's lists — and assigns the
 * index the generated record carries — before any pinned module is loaded.
 * Over the reached slice the two agree by construction: every input
 * `pluginSignature` reads past the name is a folded custom-code record or a
 * folded sampler declaration, the rest being the fields that refuse at
 * generation. Insertion order is kept rather than sorted for the same
 * reason the pin keeps it: `pluginSignature` stringifies both records as
 * written.
 */
export function materialPluginListKey(
    plugins: readonly MaterialPluginManifest[],
): string {
    return JSON.stringify(
        plugins.map((plugin) => [
            plugin.name,
            plugin.fragment ?? null,
            plugin.vertex ?? null,
            plugin.samplers ?? null,
            plugin.defines ?? null,
            plugin.uniforms ?? null,
            plugin.varyings ?? null,
        ]),
    );
}

/**
 * The Standard feature bits each registered list contributes, by the
 * compiler's own 1-based index minus one.
 *
 * A module global, like the pinned registries it mirrors: `_sigToIndex` and
 * `_indexToEntry` are module state in both bridges, so a second scene
 * composed in this process would keep the first one's numbering either way.
 * The pipeline runs one scene per process (`src/scene-command.ts` spawns
 * `cli.js` per scene), which is what makes that safe here.
 */
let bridges: Promise<readonly RegisteredPluginList[]> | undefined;

/** What one registered list contributes, read back off the pin's bridge. */
interface RegisteredPluginList {
    /** The Standard feature bits `registerStdPlugins` pre-baked. */
    bits: number;
    /**
     * The texture and sampler binding names the pin's own composed plugin
     * fragment declares, paired in `getSamplers` order.
     *
     * Taken from `stdPluginExt._frag`'s own `_bindings` rather than
     * re-concatenated from the manifests: the pairing, the order and the
     * exclusion of any non-texture binding are `buildPluginFragment`'s, and
     * a second derivation here would be a copy of it that could disagree.
     */
    bindings: readonly MaterialPluginSamplerManifest[];
}

/** The pinned binding declaration shape `buildPluginFragment` emits. */
interface PinnedBindingDecl {
    _name: string;
    _type: { _kind: string };
}

/**
 * Registers both plugin bridges, once, exactly where the pin's opt-in does.
 *
 * `enableMaterialPlugins` registers the PBR bridge and then hands the
 * Standard one the scene's meshes so it can pre-bake a signature index into
 * each plugin material's cached `_renderFeatures` — Standard's feature
 * computation is not extension-extensible, so the index has to be there
 * before the build reads it. This port has no pin meshes to walk, so it
 * hands `registerStdPlugins` one synthetic mesh per distinct plugin list, in
 * the order the compiler numbered them, and reads the bake back. The pin
 * still assigns the indices; this checks that it assigned the ones the
 * generated record already carries.
 *
 * The PBR half needs no walk: its bridge's `detect` hook encodes the index
 * during feature computation, which `_computePbrMaterialFeatures` already
 * runs for every material this port derives.
 *
 * Registration lands after the two `register*Extensions` calls have
 * installed the pin's own curated order, which is what keeps it
 * order-neutral: `_registerPbrExt` keeps a re-registered id's first
 * position, and the plugin ext declares no UBO field for the reached slice,
 * so no material block moves.
 */
async function registerPluginBridges(
    standardMaterialPlugins: readonly (readonly MaterialPluginManifest[])[],
): Promise<readonly RegisteredPluginList[]> {
    const [pbrBridge, stdBridge, pbrFlags, stdFlags, stdMaterial, stdExts] =
        await Promise.all([
            importPinnedModule<{
                registerPbrPlugins: (register: (ext: unknown) => void) => void;
            }>("material/plugin/pbr-plugin-bridge.js"),
            importPinnedModule<{
                registerStdPlugins: (
                    scene: unknown,
                    register: (ext: unknown) => void,
                ) => (deltaMs: number) => void;
            }>("material/plugin/std-plugin-bridge.js"),
            importPinnedModule<{
                _registerPbrExt: (ext: unknown) => void;
            }>("material/pbr/pbr-flags.js"),
            importPinnedModule<{
                _registerStdExt: (ext: unknown) => void;
            }>("material/standard/standard-flags.js"),
            importPinnedModule<{
                getStandardGroupBuilder: () => unknown;
            }>("material/standard/standard-group-builder.js"),
            importPinnedModule<{
                _getStdExtsSorted: () => readonly {
                    _id: string;
                    _frag: (
                        features: number,
                        meshFeatures: number,
                        material?: unknown,
                    ) => {
                        _bindings?: readonly PinnedBindingDecl[];
                    };
                }[];
            }>("material/standard/standard-flags.js"),
        ]);
    pbrBridge.registerPbrPlugins(pbrFlags._registerPbrExt);
    // One synthetic mesh per list, in the compiler's own order.
    // `registerStdPlugins` filters on the material's `_buildGroup`, which is
    // how it leaves a PBR material's `_renderFeatures` alone, so each
    // stand-in declares the Standard builder, no texture slot, and the two
    // defaults `createStandardMaterial` seeds — the same normalization
    // `pinnedStandardMaterialFeatures` performs, because the pin's detect
    // reads both as plain truthiness and an absent `backFaceCulling` would
    // otherwise derive `DOUBLE_SIDED`. A stand-in normalized that way
    // derives zero, which is what leaves the bake as the index bits alone
    // and lets the check below be an equality rather than a mask.
    const materials = standardMaterialPlugins.map((list) => ({
        plugins: pinnedPlugins(list),
        _buildGroup: stdMaterial.getStandardGroupBuilder(),
        backFaceCulling: true,
        alpha: 1,
    })) as {
        plugins: readonly PinnedPlugin[];
        _buildGroup: unknown;
        _renderFeatures?: { features: number };
        _pi?: number;
    }[];
    // 1.25.0 gives the bridge the whole scene: it walks `scene.meshes` as
    // before, and everything else it reads off one is lifetime state a
    // built scene has. `_built` false is what this stand-in is — no bindings
    // exist yet, so the bake queues no rebuild and releases nothing. The
    // engine is RECORDED on each material's state and reached only to build
    // a self-managed plugin UBO, which needs `getUniforms` — refused at
    // generation by name — so the bake leaves the buffer null and the
    // recorded engine unread. The disposer list is the scene's own;
    // generation ends the process rather than tearing a scene down, so it is
    // collected and never drained.
    stdBridge.registerStdPlugins(
        {
            meshes: materials.map((material) => ({ material })),
            _built: false,
            _disposables: [],
            surface: { engine: null },
        },
        stdFlags._registerStdExt,
    );
    const context = new LoweringContext(sharedUpstreamStore());
    const presence = pinnedPluginPresenceBit(context);
    if (standardMaterialPlugins.length > 255)
        throw new Error(
            "Native Standard material plugins support at most 255 distinct lists.",
        );
    const registered = standardPluginFragmentBindings(stdExts);
    return materials.map((material, position) => {
        const baked = material._pi;
        // The compiler numbered the lists 1..n in this order and emitted
        // that index into the material record, so the pin agreeing is what
        // makes the generated derivation's OR the pin's own bake rather than
        // a parallel numbering. `_indexFor` counts from one, in call order.
        const expected = position + 1;
        if (baked !== expected) {
            throw new Error(
                "Pinned registerStdPlugins baked plugin signature bits " +
                    `${baked} onto the list at ${position}, where the ` +
                    `generated material record carries ${expected}. The ` +
                    "bridge's index assignment no longer follows the order " +
                    "it is given the meshes.",
            );
        }
        const bindings = registered(position + 1);
        // The fold assigns each material's textures to positions in this
        // list, so a pin that reordered, dropped or unshifted a pair would
        // bind by an index the record never filled. Comparing the pairs the
        // scene declared against the ones the pin composed is what makes
        // the generated table's ordinal the pin's own position.
        const declared = standardMaterialPlugins[position]!.flatMap((plugin) =>
            (plugin.samplers ?? []).map(({ texture, sampler }) => ({
                texture,
                sampler,
            })),
        );
        if (JSON.stringify(bindings) !== JSON.stringify(declared)) {
            throw new Error(
                "Pinned buildPluginFragment composed the texture binding " +
                    `pairs ${JSON.stringify(bindings)} for the plugin list ` +
                    `at ${position}, where the scene declared ` +
                    `${JSON.stringify(declared)}.`,
            );
        }
        return { bits: presence, bindings };
    });
}

/**
 * The composed plugin fragment's own texture/sampler pairs, by index.
 *
 * `stdPluginExt._frag(features)` is how the Standard renderable resolves the
 * fragment for a material's baked word, so asking it the same question is
 * how this reads the bindings the pin composed — the alternative, rebuilding
 * the list from the manifests, would be `buildPluginFragment`'s pairing
 * written a second time.
 */
function standardPluginFragmentBindings(flags: {
    _getStdExtsSorted: () => readonly {
        _id: string;
        _frag: (
            features: number,
            meshFeatures: number,
            material?: unknown,
        ) => {
            _bindings?: readonly PinnedBindingDecl[];
        };
    }[];
}): (index: number) => readonly MaterialPluginSamplerManifest[] {
    const ext = flags
        ._getStdExtsSorted()
        .find((candidate) => candidate._id === "plugin");
    if (!ext) {
        throw new Error(
            "The pinned Standard plugin bridge did not register an " +
                "extension the composed fragment can be read from.",
        );
    }
    return (index) => {
        const declarations = ext._frag(0, 0, { _pi: index })._bindings ?? [];
        const pairs: MaterialPluginSamplerManifest[] = [];
        for (let at = 0; at < declarations.length; at += 1) {
            const texture = declarations[at]!;
            if (texture._type._kind !== "texture") continue;
            const sampler = declarations[at + 1];
            if (!sampler || sampler._type._kind !== "sampler") {
                throw new Error(
                    "Pinned buildPluginFragment no longer declares a " +
                        `sampler after texture '${texture._name}', so a ` +
                        "plugin binding pair cannot be read from it.",
                );
            }
            at += 1;
            pairs.push({ texture: texture._name, sampler: sampler._name });
        }
        return pairs;
    };
}

/**
 * Registers the bridges for a scene's plugin lists.
 *
 * Called once per generation, before any composition — the position
 * `enableMaterialPlugins(scene)` occupies upstream, which is after the
 * materials exist and before the build runs. `standardLists` are the
 * distinct plugin lists a STANDARD material carries, in the compiler's own
 * numbering order — the only ones `registerStdPlugins` would have numbered,
 * since it skips every material that is not Standard. A PBR material's
 * plugins need no list here: its bridge numbers them itself while the
 * feature derivation runs.
 */
export async function enablePinnedMaterialPlugins(
    standardMaterialPlugins: readonly (readonly MaterialPluginManifest[])[],
): Promise<void> {
    bridges ??= registerPluginBridges(standardMaterialPlugins);
    await bridges;
}

/** Execute the explicit PBR vertex-resource bridge opt-in before composition. */
export async function enablePinnedPbrMaterialPluginVertexData(): Promise<void> {
    const module = await importPinnedModule<{
        enablePbrMaterialPluginVertexData(): void;
    }>("material/plugin/enable-pbr-material-plugin-vertex-data.js");
    module.enablePbrMaterialPluginVertexData();
}

/** The plugin objects a `PinnedMaterialInput.plugins` slot carries. */
export function pinnedPlugins(
    plugins: readonly MaterialPluginManifest[],
): readonly PinnedPlugin[] {
    return plugins.map(pinnedPlugin);
}

/**
 * The Standard feature bits the list at `pluginIndex` contributes.
 *
 * This is `registerStdPlugins`'s own pre-bake, read back rather than
 * recomputed: upstream's `rebuildSingle` reads the cached
 * `_renderFeatures.features` for exactly this reason, and a second
 * derivation here would be a copy of the pin's index assignment. The index
 * is the compiler's own 1-based numbering, which is the same one the
 * generated material record carries.
 */
export async function standardPluginFeatureBits(
    pluginIndex: number | undefined,
): Promise<number> {
    if (pluginIndex === undefined) return 0;
    const list = (await bridges)?.[pluginIndex - 1];
    if (list === undefined) {
        throw new Error(
            `Material plugin list ${pluginIndex} was not registered with ` +
                "the pinned Standard bridge; every list a scene attaches " +
                "has to reach enablePinnedMaterialPlugins together, because " +
                "the pin assigns its indices in one pass.",
        );
    }
    return list.bits;
}

/**
 * The composed binding pairs each registered Standard plugin list declares,
 * by the compiler's own 1-based index — the table both backends resolve a
 * plugin binding name through.
 */
export async function standardPluginBindingTable(): Promise<
    readonly (readonly MaterialPluginSamplerManifest[])[]
> {
    return ((await bridges) ?? []).map((list) => list.bindings);
}
