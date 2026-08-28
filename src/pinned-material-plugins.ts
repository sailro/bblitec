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
 * The reached slice is the plugin scene 217 declares: a name and a
 * `getCustomCode` returning WGSL for one fragment injection point. Uniforms,
 * samplers, textures, `defines`, `priority` and `isEnabled` all refuse at
 * generation where the scene declares them, so nothing here has to answer
 * for the material UBO, the self-managed Standard `pluginUbo`, or a bind
 * group — which is why the reached slice adds no native binding at all.
 */
import ts from "typescript";
import { importPinnedModule } from "./pinned-shader-composer.js";
import { LoweringContext } from "./lowering/context.js";
import { sharedUpstreamStore } from "./upstream-source.js";

/** The pinned module the Standard bridge keeps its index layout in. */
const STD_PLUGIN_BRIDGE = "src/material/plugin/std-plugin-bridge.ts";

/** One of that module's own constants, evaluated from its declaration. */
function standardPluginConstant(
    context: LoweringContext,
    name: "PLUGIN_INDEX_SHIFT" | "PLUGIN_INDEX_MASK",
): number {
    const file = context.sourceFile(STD_PLUGIN_BRIDGE);
    return context.numericValue(
        context.variableInitializer(file, name),
        file,
    );
}

/**
 * The shift `registerStdPlugins` bakes its signature index at, taken from
 * the expression that bakes it.
 *
 * The generated Standard derivation re-emits that OR with the material
 * record's own field in place of the pin's `idx`, so what has to hold is the
 * *expression*, not just the constant: a pin that masked the bake, changed
 * the operator, or moved the shift to the other operand would still export a
 * `PLUGIN_INDEX_SHIFT` worth reading while meaning something else. Asserting
 * the shape is what makes the emitted line the pin's own line.
 */
export function pinnedPluginBakeShift(context: LoweringContext): number {
    const { declaration } = context.functionDeclaration(
        STD_PLUGIN_BRIDGE,
        "registerStdPlugins",
    );
    const [bake] = context.findNodes(
        declaration,
        (node): node is ts.BinaryExpression =>
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.BarToken,
    );
    if (!bake) {
        return context.contractError(
            declaration,
            "Pinned registerStdPlugins no longer ORs its signature index " +
                "into the material's computed feature word.",
        );
    }
    context.assertExpressionShape(
        bake,
        "_computeStandardMaterialFeatures(mat) | (idx << PLUGIN_INDEX_SHIFT)",
        "registerStdPlugins signature-index bake",
    );
    return standardPluginConstant(context, "PLUGIN_INDEX_SHIFT");
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
}

/** The shape the pin's own bridges read a plugin through. */
interface PinnedPlugin {
    readonly name: string;
    getCustomCode(
        shaderType: "vertex" | "fragment",
    ): Readonly<Record<string, string>> | null;
}

/**
 * The folded manifest as the object the pin reads.
 *
 * `pluginSignature` and `buildPluginFragment` call `getCustomCode` and
 * nothing else on a plugin declaring no uniforms or samplers, so the pin
 * sees the scene's own declaration through a closure over the folded
 * records rather than through a second implementation of it.
 */
function pinnedPlugin(manifest: MaterialPluginManifest): PinnedPlugin {
    return {
        name: manifest.name,
        getCustomCode(shaderType) {
            const code = shaderType === "fragment"
                ? manifest.fragment
                : manifest.vertex;
            return code ?? null;
        },
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
 * `pluginSignature` reads past the name is a folded custom-code record, the
 * rest being the fields that refuse at generation. Insertion order is kept
 * rather than sorted for the same reason the pin keeps it: `pluginSignature`
 * stringifies the custom-code record as written.
 */
export function materialPluginListKey(
    plugins: readonly MaterialPluginManifest[],
): string {
    return JSON.stringify(
        plugins.map((plugin) => [
            plugin.name,
            plugin.fragment ?? null,
            plugin.vertex ?? null,
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
let bridges: Promise<readonly number[]> | undefined;

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
): Promise<readonly number[]> {
    const [pbrBridge, stdBridge, pbrFlags, stdFlags, stdMaterial] =
        await Promise.all([
            importPinnedModule<{
                registerPbrPlugins: (register: (ext: unknown) => void) => void;
            }>("material/plugin/pbr-plugin-bridge.js"),
            importPinnedModule<{
                registerStdPlugins: (
                    meshes: readonly unknown[],
                    engine: unknown,
                    register: (ext: unknown) => void,
                ) => void;
            }>("material/plugin/std-plugin-bridge.js"),
            importPinnedModule<{
                _registerPbrExt: (ext: unknown) => void;
            }>("material/pbr/pbr-flags.js"),
            importPinnedModule<{
                _registerStdExt: (ext: unknown) => void;
            }>("material/standard/standard-flags.js"),
            importPinnedModule<{
                getStandardGroupBuilder: () => unknown;
            }>("material/standard/standard-material.js"),
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
    }[];
    // The engine reaches `createUniformBuffer` only for a plugin list
    // declaring UBO fields, and the compiler refuses `getUniforms` by name —
    // so there is no engine to hand over and none is asked for.
    stdBridge.registerStdPlugins(
        materials.map((material) => ({ material })),
        undefined,
        stdFlags._registerStdExt,
    );
    const context = new LoweringContext(sharedUpstreamStore());
    const shift = standardPluginConstant(context, "PLUGIN_INDEX_SHIFT");
    const mask = standardPluginConstant(context, "PLUGIN_INDEX_MASK");
    // The pin overflows the field rather than truncating, so the bound is
    // checked once here instead of masked into every draw's derivation.
    if (standardMaterialPlugins.length > mask) {
        throw new Error(
            `A scene attaching ${standardMaterialPlugins.length} distinct ` +
                "plugin lists to Standard materials exceeds the pin's own " +
                `PLUGIN_INDEX_MASK of ${mask}, past which the signature ` +
                "index runs into the feature bits beside it.",
        );
    }
    // `MaterialRecord::plugin_signature_index` is a byte, sized to that
    // mask so the field costs no padding; a pin that widened the reserved
    // field would need the record widened with it.
    if (mask > 0xff) {
        throw new Error(
            `Pinned PLUGIN_INDEX_MASK is ${mask}, which no longer fits the ` +
                "byte MaterialRecord::plugin_signature_index reserves for " +
                "it.",
        );
    }
    return materials.map((material, position) => {
        const baked = material._renderFeatures?.features;
        // The compiler numbered the lists 1..n in this order and emitted
        // that index into the material record, so the pin agreeing is what
        // makes the generated derivation's OR the pin's own bake rather than
        // a parallel numbering. `_indexFor` counts from one, in call order.
        const expected = (position + 1) << shift;
        if (baked !== expected) {
            throw new Error(
                "Pinned registerStdPlugins baked plugin signature bits " +
                    `${baked} onto the list at ${position}, where the ` +
                    `generated material record carries ${expected}. The ` +
                    "bridge's index assignment no longer follows the order " +
                    "it is given the meshes.",
            );
        }
        return baked;
    });
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
    const bits = (await bridges)?.[pluginIndex - 1];
    if (bits === undefined) {
        throw new Error(
            `Material plugin list ${pluginIndex} was not registered with ` +
                "the pinned Standard bridge; every list a scene attaches " +
                "has to reach enablePinnedMaterialPlugins together, because " +
                "the pin assigns its indices in one pass.",
        );
    }
    return bits;
}
