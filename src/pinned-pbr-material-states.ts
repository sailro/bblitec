/**
 * The composition states a program's writes give its PBR materials.
 *
 * The pin computes a material's features on its first render and keeps them
 * (`_renderFeatures`), so a material whose `alphaBlend`, `alpha`,
 * `baseColorFactor`, `bentNormalTexture`, `_parallaxOcclusion` or `plugins`
 * the program writes
 * composes from whatever it holds when it is first drawn. Generation composes
 * one row for every state those writes can reach, and
 * `pbr_material_state_rows` names each by the key the native record reaches
 * it by: the pin's blend bit, the record's plugin signature, whether a base
 * colour factor was written, under `enableBentNormals` whether it holds a
 * bent normal texture and, where the program sets parallax occlusion, whether
 * it holds an active one.
 */
import type {
    PbrMaterialStateWrites,
    PbrPluginAppend,
} from "./compiler/types.js";
import {
    materialPluginListKey,
    pinnedPlugins,
    type MaterialPluginManifest,
} from "./pinned-material-plugins.js";
import type { PbrMaterialStateRow } from "./pinned-pbr-variant-cpp.js";
import {
    pinnedMaterialFeatures,
    type PinnedMaterialInput,
} from "./pinned-pbr-variants.js";
import { importPinnedModule } from "./pinned-shader-composer.js";
import { ACTIVE_PARALLAX_OCCLUSION } from "./lowering/parallax-occlusion.js";

/** The key a state row is selected by: the entry less its rows. */
type PbrMaterialStateKey = Omit<PbrMaterialStateRow, "sourceRow" | "row">;

type AxisState<Axes extends Record<string, readonly unknown[]>> = {
    [Axis in keyof Axes]: Axes[Axis][number];
};

/** Every combination of the axes' values, the first axis outermost. */
function* axisProduct<Axes extends Record<string, readonly unknown[]>>(
    axes: Axes,
    names: readonly (keyof Axes)[] = Object.keys(axes),
    state: Partial<AxisState<Axes>> = {},
): Generator<AxisState<Axes>> {
    const [name, ...rest] = names;
    if (name === undefined) {
        // Every axis holds a value once none is left.
        yield state as AxisState<Axes>;
        return;
    }
    for (const value of axes[name] ?? [])
        yield* axisProduct(axes, rest, { ...state, [name]: value });
}

/** One state a source row composes in. */
export interface PbrMaterialState {
    /** The table row it composes into: the source row for its own state. */
    readonly row: number;
    readonly input: PinnedMaterialInput;
    /** The plugin list the state holds. */
    readonly plugins?: readonly MaterialPluginManifest[];
}

/**
 * The rows written materials compose in, numbered past every row the
 * program's handles name, and the entries that select them.
 */
export class PbrMaterialStates {
    private readonly entries: PbrMaterialStateRow[] = [];
    /** Each source row's state keys and the row composed for each. */
    private readonly rowsBySource = new Map<number, Map<string, number>>();
    private readonly signatureByKey = new Map<string, number>();
    /** The signature each list takes with one more plugin, by `signature:plugin`. */
    private readonly grownBy = new Map<string, number>();
    private nextRow: number;

    constructor(
        firstRow: number,
        /** The writes reaching each source row. */
        private readonly writes: ReadonlyMap<number, PbrMaterialStateWrites>,
        /** The compiler's PBR plugin lists, by signature from one. */
        private readonly signatures: readonly (readonly MaterialPluginManifest[])[],
        /** The appends that grow a list (`SceneMaterialRecorder.closePbrPluginSignatures`). */
        appends: readonly PbrPluginAppend[],
        /**
         * `enableBentNormals` reached: without it the pin's IBL extension
         * has no `detect`, so a bent normal texture composes nothing.
         */
        private readonly bentNormals: boolean,
        /** `material:parallax-occlusion` reached: the key carries its presence. */
        private readonly parallax: boolean,
    ) {
        this.nextRow = firstRow;
        signatures.forEach((list, index) =>
            this.signatureByKey.set(materialPluginListKey(list), index + 1),
        );
        for (const { signature, plugin, grown } of appends)
            this.grownBy.set(`${signature}:${plugin}`, grown);
    }

    /** Every composed row: the handles' own and the states' after them. */
    public get rowCount(): number {
        return this.nextRow;
    }

    /** The entries of every source row a write can move off its own row. */
    public get stateRows(): readonly PbrMaterialStateRow[] {
        return this.entries.filter(
            (entry) => this.rowsBySource.get(entry.sourceRow)!.size > 1,
        );
    }

    /**
     * The states one source row composes in, its own first. Every caller
     * composing that row (its colour pass, its caster views, its geometry
     * tasks) is handed the same rows for the same keys.
     */
    public async of(
        sourceRow: number,
        input: PinnedMaterialInput,
        plugins?: readonly MaterialPluginManifest[],
    ): Promise<readonly PbrMaterialState[]> {
        const writes = this.writes.get(sourceRow);
        if (!writes) return [ownState(sourceRow, input, plugins)];
        const { PBR_HAS_ALPHA_BLEND } = await importPinnedModule<{
            PBR_HAS_ALPHA_BLEND: number;
        }>("material/pbr/pbr-flag-bits.js");
        let rows = this.rowsBySource.get(sourceRow);
        if (!rows) {
            rows = new Map();
            this.rowsBySource.set(sourceRow, rows);
        }
        const states: PbrMaterialState[] = [];
        const reached = new Set<string>();
        const baseSignature = this.signatureOf(plugins ?? []);
        // `alpha` composes only through which side of 1 it falls on.
        const alphas = [input.alpha];
        for (const below of new Set(writes.alphaBelowOne))
            if (below !== (input.alpha !== undefined && input.alpha < 1))
                alphas.push(below ? 0.5 : 1);
        const axes = {
            signature: this.reachableSignatures(baseSignature, writes),
            factorWritten: writes.baseColorFactor ? [false, true] : [false],
            // A definite write leaves its materials no textureless state.
            bentNormalTexture: !this.bentNormals
                ? [false]
                : writes.bentNormalTexture === "definite"
                  ? [true]
                  : writes.bentNormalTexture
                    ? [false, true]
                    : [false],
            // Its `detect` reads presence and a nonzero `heightScale`; a
            // setter can clear it as well as set it.
            parallaxOcclusion: writes.parallaxOcclusion
                ? [false, true]
                : [input["_parallaxOcclusion"] !== undefined],
            alphaBlend: [...new Set([input.alphaBlend, ...writes.alphaBlend])],
            alpha: alphas,
        };
        for (const state of axisProduct(axes)) {
            const own = state.signature === baseSignature;
            const held =
                state.signature === 0
                    ? []
                    : this.signatures[state.signature - 1]!;
            const candidate = this.stateInput(
                input,
                state,
                own ? undefined : held,
            );
            // The pin's own blend term decides which states share a row, so
            // no restatement of it can drift.
            const key: PbrMaterialStateKey = {
                blend:
                    ((await pinnedMaterialFeatures({ ...candidate })).features &
                        PBR_HAS_ALPHA_BLEND) !==
                    0,
                pluginSignature: state.signature,
                baseColorFactorWritten: state.factorWritten,
                ...(this.bentNormals
                    ? { bentNormalTexture: state.bentNormalTexture }
                    : {}),
                ...(this.parallax
                    ? { parallaxOcclusion: state.parallaxOcclusion }
                    : {}),
            };
            const id = JSON.stringify(key);
            if (reached.has(id)) continue;
            reached.add(id);
            let row = rows.get(id);
            if (row === undefined) {
                row = rows.size === 0 ? sourceRow : this.nextRow++;
                rows.set(id, row);
                this.entries.push({ sourceRow, ...key, row });
            }
            const statePlugins = own
                ? plugins
                : held.length > 0
                  ? held
                  : undefined;
            states.push({
                row,
                input: candidate,
                ...(statePlugins ? { plugins: statePlugins } : {}),
            });
        }
        return states;
    }

    private stateInput(
        input: PinnedMaterialInput,
        state: {
            alphaBlend: boolean | undefined;
            alpha: number | undefined;
            factorWritten: boolean;
            bentNormalTexture: boolean;
            parallaxOcclusion: boolean;
        },
        /** The plugin list, when the state holds another than the input's. */
        held: readonly MaterialPluginManifest[] | undefined,
    ): PinnedMaterialInput {
        // An absent value is the input's own, which it then also lacks.
        const candidate: PinnedMaterialInput = {
            ...input,
            ...(state.alphaBlend === undefined
                ? {}
                : { alphaBlend: state.alphaBlend }),
            ...(state.alpha === undefined ? {} : { alpha: state.alpha }),
        };
        // A written factor composes through its presence alone.
        if (state.factorWritten) candidate.baseColorFactor ??= [1, 1, 1, 1];
        // So does a written bent normal texture.
        if (state.bentNormalTexture) candidate["bentNormalTexture"] = {};
        // And an active parallax occlusion through its presence alone.
        if (state.parallaxOcclusion)
            candidate["_parallaxOcclusion"] ??= ACTIVE_PARALLAX_OCCLUSION;
        else delete candidate["_parallaxOcclusion"];
        if (held !== undefined) {
            if (held.length > 0) candidate["plugins"] = pinnedPlugins(held);
            else delete candidate["plugins"];
        }
        return candidate;
    }

    /** The plugin signatures a source row can hold, its own first. */
    private reachableSignatures(
        base: number,
        writes: PbrMaterialStateWrites,
    ): number[] {
        const reached = [base];
        for (const signature of writes.pluginSignatures)
            if (!reached.includes(signature)) reached.push(signature);
        for (let at = 0; at < reached.length; at += 1)
            for (const plugin of writes.pluginAppends) {
                // A list already holding the plugin keeps its signature.
                const grown = this.grownBy.get(`${reached[at]}:${plugin}`);
                if (grown !== undefined && !reached.includes(grown))
                    reached.push(grown);
            }
        return reached;
    }

    private signatureOf(list: readonly MaterialPluginManifest[]): number {
        if (list.length === 0) return 0;
        const signature = this.signatureByKey.get(materialPluginListKey(list));
        if (signature === undefined)
            throw new Error(
                "A PBR material holds a plugin list the compiler did not " +
                    "number, so no state row can name it.",
            );
        return signature;
    }
}

function ownState(
    row: number,
    input: PinnedMaterialInput,
    plugins: readonly MaterialPluginManifest[] | undefined,
): PbrMaterialState {
    return { row, input, ...(plugins ? { plugins } : {}) };
}

/** A source row's states, or its own alone when no writes reach materials. */
export async function pbrMaterialStatesOf(
    states: PbrMaterialStates | undefined,
    sourceRow: number,
    input: PinnedMaterialInput,
    plugins?: readonly MaterialPluginManifest[],
): Promise<readonly PbrMaterialState[]> {
    return states
        ? states.of(sourceRow, input, plugins)
        : [ownState(sourceRow, input, plugins)];
}
