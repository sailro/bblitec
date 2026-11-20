// Shader materials derived at run time from another material's own creation
// options, looked up by that material's identity.
//
// A program keeps the options a material was created from in a map keyed by
// the material (`recipes.set(material, { options, ... })`) and later creates
// another material from them (`createShaderMaterial({ ...recipe.options,
// fragmentSource, ... })`, `recipe = recipes.get(source)`). The source is a
// run-time value there, but each store names the variant its key was created
// with and the options generation read to create it, so the derived material
// compiles once per source variant and selects its variant at run time from
// the source's (`derived_shader_variant_<site>`).
//
// Every variant keeps the options it was created from, so a material of a
// known variant answers the fields the pin's `createShaderMaterial` builds
// from them (`pinnedShaderMaterialField`).
import ts from "typescript";
import { doubleLiteral } from "../cpp-literals.js";
import { constInitializer } from "./browser-erasure.js";
import { unlessRefused } from "./compile-error.js";
import {
    emissionArray,
    EmissionMap,
    EmissionSet,
} from "./emission-transaction.js";
import { pinnedModuleFunction } from "../lowering/pinned-shader-builders.js";
import { jsonToValue, type JsonValuePolicy } from "./json-value.js";
import type {
    LoweringServices,
    ShaderSourceText,
} from "./lowering-services.js";
import { staticJsonValue } from "./option-helpers.js";
import { forEachReturn } from "./loop-control.js";
import { parameterIsRebound } from "./parameter-effects.js";
import {
    arrayWriteObservation,
    recordFieldIsWritten,
    recordKeysAreWritten,
} from "./record-observations.js";
import { sourceFilesWalk } from "./analysis-walk.js";
import { calledFunction, calledOrigin, namedMember } from "./symbols.js";
import {
    isSupportedFunction,
    isValueReference,
    notJson,
    isSuspensionPoint,
    objectLiteralMembers,
    outermostWrapper,
    unwrapExpression,
    variableKind,
} from "./syntax.js";
import { isPinnedType } from "./data-types.js";
import {
    arrayShape,
    callSignatures,
    holdsOnly,
    isTypeReference,
    presentMembers,
} from "./type-facts.js";
import type { CompiledShaderMaterialOptions } from "./shader-material.js";
import type { ShaderStage } from "../shader-ir.js";
import type { CompiledShaderProgram, Value } from "./types.js";
import {
    absenceOf,
    shaderVariantsOf,
    undefinedValue,
    valueForKind,
} from "./values/model.js";
import {
    directMapCalls,
    shaderSideTable,
    sideTableStoreFact,
    type ShaderSideTableFact,
} from "./shader-side-tables.js";
import { programObservations } from "./program-observations.js";
import { sourceTypeHasObservedIdentity } from "./storage-demand-index.js";

/**
 * One own key of a record: plain data generation knows, plain data some of
 * whose leaves only the run time holds (`RuntimeLeaf`), `undefined`, or a
 * value only the run time holds.
 */
export type RecordFact =
    | { readonly json: unknown }
    | { readonly partial: unknown }
    | "undefined"
    | "runtime";

/** The known-data arm of a record fact: plain data, whole or with run-time leaves. */
export type DataFact = Exclude<RecordFact, "undefined" | "runtime">;

/**
 * A leaf of a declaration list's plain data only the run time holds: a
 * number, or (`lanes`) an array of numbers; `shared` says why the array may
 * change after the list holds it, where it may.
 */
export class RuntimeLeaf {
    constructor(
        readonly lanes: boolean,
        readonly shared?: string,
    ) {}

    /** The identity a reading of the facts records it by. */
    public toJSON(): unknown {
        return {
            [runtimeLeafKey]: [this.lanes ? "lanes" : "number", this.shared],
        };
    }
}

const runtimeLeafKey = "\u0000runtime";

/**
 * A leaf of a declaration list's plain data the list holds where generation
 * cannot read it: a read of it refuses with `refusal` (`unreadableValue`).
 */
export class UnreadableLeaf {
    constructor(readonly refusal: string) {}

    /** The identity a reading of the facts records it by. */
    public toJSON(): unknown {
        return { [unreadableLeafKey]: this.refusal };
    }
}

const unreadableLeafKey = "\u0000unreadable";

/** Whether a fact holds a value only the run time holds, whole or in part. */
export function runTimeFact(fact: RecordFact): boolean {
    return (
        fact === "runtime" || (typeof fact === "object" && "partial" in fact)
    );
}

/** Whether plain data holds a leaf generation does not hold (`RuntimeLeaf`, `UnreadableLeaf`). */
export function holdsRuntimeLeaf(json: unknown): boolean {
    if (json instanceof RuntimeLeaf || json instanceof UnreadableLeaf)
        return true;
    if (Array.isArray(json)) return json.some(holdsRuntimeLeaf);
    return (
        typeof json === "object" &&
        json !== null &&
        Object.values(json).some(holdsRuntimeLeaf)
    );
}

/** Plain data as a fact: partial where it holds a run-time leaf (`holdsRuntimeLeaf`). */
export function dataFact(data: unknown): DataFact {
    return holdsRuntimeLeaf(data) ? { partial: data } : { json: data };
}

/** The refusal of the first `UnreadableLeaf` a fact holds. */
export function unreadableFactRefusal(fact: RecordFact): string | undefined {
    const find = (json: unknown): string | undefined => {
        if (json instanceof UnreadableLeaf) return json.refusal;
        if (typeof json !== "object" || json === null) return undefined;
        for (const part of Object.values(json)) {
            const found = find(part);
            if (found !== undefined) return found;
        }
        return undefined;
    };
    return typeof fact === "object" && "partial" in fact
        ? find(fact.partial)
        : undefined;
}

/** A copy of plain data, each leaf generation does not hold kept as one. */
function copyPlainData(json: unknown): unknown {
    return JSON.parse(JSON.stringify(json), (_key, value: unknown) => {
        if (typeof value !== "object" || value === null) return value;
        if (Object.hasOwn(value, unreadableLeafKey))
            return new UnreadableLeaf(
                String(Reflect.get(value, unreadableLeafKey)),
            );
        if (!Object.hasOwn(value, runtimeLeafKey)) return value;
        const marker: unknown = Reflect.get(value, runtimeLeafKey);
        const shape: unknown = Array.isArray(marker) ? marker[0] : undefined;
        const shared: unknown = Array.isArray(marker) ? marker[1] : undefined;
        return new RuntimeLeaf(
            shape === "lanes",
            typeof shared === "string" ? shared : undefined,
        );
    });
}

/** A record's own keys in order, with what each holds. */
export type RecordFacts = ReadonlyMap<string, RecordFact>;

/** What `createShaderMaterial` read its options as, carried by the material. */
export interface ShaderCreation {
    readonly options: RecordFacts;
    /** The binding that named the options object, in the scope that read it. */
    readonly binding?: { readonly symbol: ts.Symbol; readonly scope: object };
    /** The creation expression, and its per-material immutable side-table facts. */
    readonly site?: ts.CallExpression;
    readonly sideTables?: Map<ts.Symbol, ShaderSideTableFact>;
}

/** A `get` of a recipe map: the map, and the material key as spelled there. */
export interface ShaderRecipeLookup {
    readonly map: ts.Symbol;
    readonly materialCpp: string;
    readonly engineCpp: string;
}

/** One store of a recipe map whose key's creation options are known. */
interface RecipeStore {
    /** The key material's shader variant. */
    readonly variant: number;
    /** The member holding the key's creation options. */
    readonly member: string;
    readonly options: RecordFacts;
    /** The record's other own keys. */
    readonly members: RecordFacts;
}

/**
 * The programs `createShaderMaterial` created in a compile attempt, with
 * their options and side-table facts: what the next attempt's run-time
 * variant splits take as the whole program's creations.
 */
export type ShaderCreationLedger = readonly {
    readonly program: CompiledShaderProgram;
    readonly creations: readonly (readonly [string, RecordFact])[][];
    readonly sideTables?: readonly (readonly [
        ts.Symbol,
        ShaderSideTableFact,
    ])[];
}[];

/**
 * A run-time variant split compiled before some of the program's shader
 * material creations: lowering restarts with all of them known.
 */
export class ShaderCreationsRequired extends Error {
    constructor(readonly ledger: ShaderCreationLedger) {
        super("A run-time shader variant split requires every creation.");
    }
}

export type ShaderDerivationContext = Pick<
    LoweringServices,
    | "bindings"
    | "captureEmittedLines"
    | "checker"
    | "compileValue"
    | "cppString"
    | "evaluationOrder"
    | "fail"
    | "hasStableNativeBinding"
    | "intrinsicOptions"
    | "memberLiteral"
    | "objectProperties"
    | "objectProperty"
    | "probeEmission"
    | "program"
    | "propertyName"
    | "resolveStaticLiteral"
    | "sceneManifest"
    | "staticListItems"
    | "staticLiteralData"
    | "symbols"
    | "unwrap"
>;

type RecipeStoreContext = Pick<
    ShaderDerivationContext,
    | "bindings"
    | "checker"
    | "evaluationOrder"
    | "fail"
    | "program"
    | "propertyName"
    | "sceneManifest"
    | "staticLiteralData"
    | "symbols"
    | "unwrap"
>;

/** Generation facts arrive as JSON: numbers are JavaScript doubles. */
export const recipeFactPolicy: JsonValuePolicy = {
    numberLiteral: doubleLiteral,
    nullCpp: "std::nullopt",
    staticMetadata: true,
    unsupportedMessage:
        "A shader material recipe holds a value JSON cannot represent.",
};

/**
 * Creation-owned side-table facts and recipe stores, by material and map.
 * Side-table read snapshots join the creation ledger when later creations
 * change them. A recipe store compiled after a derivation of its map
 * refuses: the recipe derivation's variant table is closed by then.
 */
export class ShaderDerivationRecorder {
    private readonly materials = emissionArray<{
        readonly variant: string;
        readonly creation: ShaderCreation;
    }>();
    private readonly sideTableSeeds = new EmissionMap<
        string,
        ReadonlyMap<ts.Symbol, ShaderSideTableFact>
    >();
    private readonly sideTableReads = new EmissionMap<
        ts.Symbol,
        ReadonlyMap<string, ShaderSideTableFact>
    >();

    public recordMaterial(variant: string, creation: ShaderCreation): void {
        this.materials.push({ variant, creation });
    }

    public seedSideTables(
        variant: string,
        facts: readonly (readonly [ts.Symbol, ShaderSideTableFact])[],
    ): void {
        this.sideTableSeeds.set(variant, new Map(facts));
    }

    private materialSideTable(
        map: ts.Symbol,
        variant: string,
    ): ShaderSideTableFact {
        const facts = this.materials
            .filter((material) => material.variant === variant)
            .map(
                ({ creation }) =>
                    creation.sideTables?.get(map) ?? { absent: true as const },
            );
        const first = facts[0] ?? { absent: true as const };
        return facts.some(
            (fact) => JSON.stringify(fact) !== JSON.stringify(first),
        )
            ? {
                  refusal: `materials of shader variant '${variant}' have different side-table entries (including absence)`,
              }
            : first;
    }

    public readSideTable(map: ts.Symbol, variant: string): ShaderSideTableFact {
        const fact =
            this.sideTableSeeds.get(variant)?.get(map) ??
            this.materialSideTable(map, variant);
        this.sideTableReads.set(
            map,
            new Map([...(this.sideTableReads.get(map) ?? []), [variant, fact]]),
        );
        return fact;
    }
    private readonly stores = new EmissionMap<
        ts.Symbol,
        readonly RecipeStore[]
    >();
    private readonly opaque = new EmissionMap<ts.Symbol, string>();
    private readonly derived = new EmissionSet<ts.Symbol>();
    /** Each derivation site's source variant to derived variant. */
    private readonly sites = emissionArray<ReadonlyMap<number, number>>();
    /** The distinct options each shader variant was compiled from, by variant name. */
    private readonly creations = new EmissionMap<
        string,
        readonly RecordFacts[]
    >();

    /** The JSON identity of each reading `creations` (by variant) and `stores` (by map) hold. */
    private readonly identities = new EmissionMap<
        string | ts.Symbol,
        EmissionSet<string>
    >();

    /** Whether `identity` is a reading `owner` does not hold yet, which it then holds. */
    private firstReading(owner: string | ts.Symbol, identity: string): boolean {
        const known = this.identities.get(owner);
        if (known?.has(identity)) return false;
        if (known) known.add(identity);
        else this.identities.set(owner, new EmissionSet([identity]));
        return true;
    }

    /** The variants `createShaderMaterial` created, as opposed to derived ones. */
    private readonly created = new EmissionSet<string>();
    /** The created variants each run-time variant split compiled arms for. */
    private readonly splits = emissionArray<ReadonlySet<string>>();
    /** The refusals of the sites that met no created variant. */
    private readonly uncreated = emissionArray<() => never>();

    /**
     * Records the options a variant compiled from, once per distinct
     * reading; `created` when `createShaderMaterial` created it.
     */
    public recordCreation(
        variant: string,
        options: RecordFacts,
        created = false,
    ): void {
        if (created) this.created.add(variant);
        if (!this.firstReading(variant, JSON.stringify([...options]))) return;
        this.creations.set(variant, [
            ...(this.creations.get(variant) ?? []),
            options,
        ]);
    }

    /** The variants `createShaderMaterial` created, in reach order of their records. */
    public createdVariants(): readonly string[] {
        return [...this.created];
    }

    /** Records the created variants a run-time variant split compiled arms for. */
    public recordSplit(variants: readonly string[]): void {
        this.splits.push(new Set(variants));
    }

    /**
     * Records the refusal of a site a run-time variant split compiled
     * before any variant was created: a later creation compiles it again
     * (`splitLedger`), and it stands where the program creates none.
     */
    public refuseWithoutCreations(refuse: () => never): void {
        this.uncreated.push(refuse);
    }

    /** Refuses as the first site that met no created variant, where the program creates none. */
    public refuseUncreated(): void {
        if (this.created.size === 0) this.uncreated[0]?.();
    }

    /**
     * The whole program's created variants, when a run-time variant split
     * compiled before some of them were created: the next attempt splits on
     * all of them (`ShaderCreationsRequired`).
     */
    public splitLedger(
        programs: readonly CompiledShaderProgram[],
    ): ShaderCreationLedger | undefined {
        const created = this.createdVariants();
        const changedSideTables = [...this.sideTableReads].some(
            ([map, variants]) =>
                [...variants].some(
                    ([variant, read]) =>
                        JSON.stringify(read) !==
                        JSON.stringify(this.materialSideTable(map, variant)),
                ),
        );
        if (
            !changedSideTables &&
            !this.splits.some((split) =>
                created.some((variant) => !split.has(variant)),
            )
        )
            return undefined;
        return created.map((variant) => ({
            program: programs.find((program) => program.name === variant)!,
            creations: this.creationsOf(variant).map((facts) => [...facts]),
            sideTables: [...this.sideTableReads.keys()].map((map) => [
                map,
                this.materialSideTable(map, variant),
            ]),
        }));
    }

    /** The options a variant compiled from: one entry per distinct reading. */
    public creationsOf(variant: string): readonly RecordFacts[] {
        return this.creations.get(variant) ?? [];
    }

    public recordStore(
        map: ts.Symbol,
        store: RecipeStore | string,
        node: ts.Node,
        context: Pick<LoweringServices, "fail">,
    ): void {
        if (this.derived.has(map))
            context.fail(
                node,
                "A shader material recipe is stored after a material derived from this map compiled; the derivation's variants are closed by then.",
            );
        if (typeof store === "string") {
            if (!this.opaque.has(map)) this.opaque.set(map, store);
            return;
        }
        if (
            !this.firstReading(
                map,
                JSON.stringify([
                    store.variant,
                    store.member,
                    [...store.options],
                    [...store.members],
                ]),
            )
        )
            return;
        this.stores.set(map, [...(this.stores.get(map) ?? []), store]);
    }

    /** The stores a derivation reads, or why the map's recipes are unknown. */
    public recipes(map: ts.Symbol): readonly RecipeStore[] | string {
        return this.opaque.get(map) ?? this.stores.get(map) ?? [];
    }

    /**
     * The variant a derivation site creates from its source's, `source`
     * spelling the source's variant and `variants` the site's table; a
     * recipe map's stores close once one derives from it.
     */
    public derivedVariantCpp(
        map: ts.Symbol | undefined,
        variants: ReadonlyMap<number, number>,
        source: string,
    ): string {
        if (map) this.derived.add(map);
        const site = this.sites.push(variants) - 1;
        return `bblscene::${derivedVariantFunction(site)}(${source})`;
    }

    /** One function per derivation site, from source variant to derived variant. */
    public functionsCpp(): string[] {
        return this.sites.flatMap((variants, site) => [
            ...(site > 0 ? [""] : []),
            `// The shader variant derivation site ${site} creates from its source material's variant.`,
            `[[maybe_unused]] inline std::uint32_t ${derivedVariantFunction(site)}(std::uint32_t source) {`,
            "    switch (source) {",
            ...[...variants]
                .sort(([left], [right]) => left - right)
                .map(
                    ([source, derived]) =>
                        `        case ${source}u: return ${derived}u;`,
                ),
            '        default: throw std::runtime_error("A material derivation reached a source shader variant generation did not derive from.");',
            "    }",
            "}",
        ]);
    }
}

/** The function a derivation site's table compiles to. */
function derivedVariantFunction(site: number): string {
    return `derived_shader_variant_${site}`;
}

/** `createShaderMaterial` calls whose options spread a member chain. */
const derivationSites = sourceFilesWalk(
    (node: ts.Node, symbols: ShaderDerivationContext["symbols"]) =>
        ts.isCallExpression(node) &&
        node.arguments.length === 1 &&
        ts.isObjectLiteralExpression(node.arguments[0]!) &&
        node.arguments[0].properties.some(
            (property) =>
                ts.isSpreadAssignment(property) &&
                ts.isPropertyAccessExpression(
                    unwrapExpression(property.expression),
                ),
        ) &&
        symbols.importedName(node.expression) === "createShaderMaterial"
            ? node
            : undefined,
);

/**
 * Whether the program derives a shader material from a recipe's options:
 * only then do recipe maps keep their stores.
 */
function derivesShaderMaterials(
    context: Pick<ShaderDerivationContext, "program" | "symbols">,
): boolean {
    return (
        derivationSites(context.program.getSourceFiles(), context.symbols)
            .length > 0
    );
}

/** A ShaderMaterial field the pin's `createShaderMaterial` builds from its options. */
interface ShaderMaterialField {
    /** The option the field is built from. */
    readonly option: string;
    /** Every option the pin's value of the field reads, where it reads others too. */
    readonly reads?: readonly string[];
    /** An option `createShaderMaterial` validates whatever it builds. */
    readonly required?: true;
    /** A WGSL source: the stage `createShaderMaterial` compiles it as. */
    readonly stage?: ShaderStage;
    /** An option holding a declaration list, read item by item. */
    readonly items?: true;
    /** Generation reads the field as the plain data the pin builds (`pinnedShaderMaterialField`). */
    readonly built?: true;
    /**
     * The member of each option item the pin copies into the field's item
     * at the same index, reading it otherwise only in checks the creation
     * made (`compileShaderUniformComponents`): its run-time leaves are the
     * field's.
     */
    readonly copies?: string;
    /**
     * The native list holding the field's names (`bbl::ShaderDeclarationList`);
     * `names` where its entries are the names themselves.
     */
    readonly nativeList?: { readonly cpp: string; readonly names?: true };
}

/**
 * The ShaderMaterial fields `createShaderMaterial` builds from its options.
 * A material view redefines the public ones; the pin's own (`_`-prefixed)
 * stay its source's.
 */
const SHADER_MATERIAL_FIELDS: Readonly<Record<string, ShaderMaterialField>> = {
    vertexSource: {
        option: "vertexSource",
        required: true,
        stage: "vertex",
        built: true,
    },
    fragmentSource: {
        option: "fragmentSource",
        required: true,
        stage: "fragment",
        built: true,
    },
    attributes: {
        option: "attributes",
        required: true,
        nativeList: {
            cpp: "bbl::ShaderDeclarationList::attributes",
            names: true,
        },
    },
    uniformDecls: {
        option: "uniforms",
        items: true,
        built: true,
        copies: "defaultValue",
        nativeList: { cpp: "bbl::ShaderDeclarationList::uniforms" },
    },
    samplerDecls: {
        option: "samplers",
        items: true,
        built: true,
        nativeList: { cpp: "bbl::ShaderDeclarationList::samplers" },
    },
    _externalTextureDecls: { option: "externalTextures", items: true },
    storageBufferDecls: {
        option: "storageBuffers",
        items: true,
        built: true,
        nativeList: { cpp: "bbl::ShaderDeclarationList::storage_buffers" },
    },
    needAlphaBlending: {
        option: "needAlphaBlending",
        reads: ["needAlphaBlending", "blend"],
    },
    blendMode: { option: "blendMode" },
    blend: { option: "blend" },
    transmissive: { option: "transmissive" },
    needAlphaTesting: { option: "needAlphaTesting" },
    backFaceCulling: { option: "backFaceCulling" },
    depthWrite: {
        option: "depthWrite",
        reads: ["depthWrite", "needAlphaBlending", "blend"],
    },
    depthCompare: { option: "depthCompare" },
    depthOnlyFragment: { option: "depthOnlyFragment" },
    depthBias: { option: "depthBias" },
    depthBiasSlopeScale: { option: "depthBiasSlopeScale" },
};

/** The ShaderMaterial field `name` names, when `createShaderMaterial` builds one. */
export function shaderMaterialField(
    name: string,
): ShaderMaterialField | undefined {
    return Object.hasOwn(SHADER_MATERIAL_FIELDS, name)
        ? SHADER_MATERIAL_FIELDS[name]
        : undefined;
}

/** The fields a material view may redefine, in the pin's order. */
export function viewFields(): readonly string[] {
    return Object.keys(SHADER_MATERIAL_FIELDS).filter(
        (name) => !name.startsWith("_"),
    );
}

/**
 * `fact` with the member each item of declaration list option `key` copies
 * into its field (`copies`) mapped by `map`, dropped where it answers
 * undefined; any other fact as it is.
 */
function mapCopiedMembers(
    key: string,
    fact: RecordFact,
    map: (member: unknown, item: object) => unknown,
): RecordFact {
    const copies = Object.values(SHADER_MATERIAL_FIELDS).find(
        (field) => field.option === key,
    )?.copies;
    if (copies === undefined || typeof fact !== "object") return fact;
    const data: unknown = "json" in fact ? fact.json : fact.partial;
    if (!Array.isArray(data)) return fact;
    const items = data.map((item: unknown): unknown => {
        if (
            typeof item !== "object" ||
            item === null ||
            Object.getPrototypeOf(item) !== Object.prototype ||
            !Object.hasOwn(item, copies)
        )
            return item;
        const mapped = map(Reflect.get(item, copies), item);
        return Object.fromEntries(
            Object.entries(item).flatMap(([name, value]) =>
                name !== copies
                    ? [[name, value]]
                    : mapped === undefined
                      ? []
                      : [[name, mapped]],
            ),
        );
    });
    return dataFact(items);
}

/**
 * Option `key`'s fact as a material view's program reads it: the pin's
 * views take no defaults (a view draws with its source's uniform values),
 * so the member each item copies into the field (`copies`) is not read.
 */
export function viewProgramFact(key: string, fact: RecordFact): RecordFact {
    return mapCopiedMembers(key, fact, () => undefined);
}

/**
 * Option `key`'s fact as a view's redefinition holds it, for reads of the
 * view's field: a copied member (`copies`) holding a part the run time
 * decides is a leaf a read refuses (`refusal` of the item), since the
 * view's program takes none and generation keeps none.
 */
export function viewDefinitionFact(
    key: string,
    fact: RecordFact,
    refusal: (item: object) => string,
): RecordFact {
    return mapCopiedMembers(key, fact, (member, item) =>
        member instanceof UnreadableLeaf || !holdsRuntimeLeaf(member)
            ? member
            : new UnreadableLeaf(refusal(item)),
    );
}

/** The fields whose pinned value reads other options too. */
export function fieldsReadingOthers(): ReadonlyArray<
    readonly [
        string,
        ShaderMaterialField & { readonly reads: readonly string[] },
    ]
> {
    return Object.entries(SHADER_MATERIAL_FIELDS).flatMap(([name, field]) =>
        field.reads ? [[name, { ...field, reads: field.reads }] as const] : [],
    );
}

/** The options holding declaration lists, read item by item. */
const LISTED_OPTIONS: ReadonlySet<string> = new Set(
    Object.values(SHADER_MATERIAL_FIELDS).flatMap((field) =>
        field.items ? [field.option] : [],
    ),
);

/**
 * Whether the native declaration list of field `list` lowers `method` over
 * it (`shader-declaration-lists.ts`): `some` over any list, `includes`
 * over a list of names.
 */
export function nativeListSearch(list: string, method: string): boolean {
    const native = shaderMaterialField(list)?.nativeList;
    return (
        native !== undefined &&
        (method === "some" || (method === "includes" && native.names === true))
    );
}

/**
 * Whether a field read is one the native declaration list lowers: the list
 * a `for (const <name> of ...)` walks, or the receiver of a search
 * `nativeListSearch` names.
 */
function readsNativeDeclarationList(
    read: ts.PropertyAccessExpression,
): boolean {
    if (
        ts.isOptionalChain(read) ||
        !shaderMaterialField(read.name.text)?.nativeList
    )
        return false;
    const outer = outermostWrapper(read);
    const parent = outer.parent;
    if (ts.isForOfStatement(parent)) {
        const head = parent.initializer;
        return (
            parent.expression === outer &&
            !isSuspensionPoint(parent) &&
            ts.isVariableDeclarationList(head) &&
            head.declarations.length === 1 &&
            ts.isIdentifier(head.declarations[0]!.name)
        );
    }
    return (
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === outer &&
        !parent.questionDotToken &&
        ts.isCallExpression(parent.parent) &&
        parent.parent.expression === parent &&
        !parent.parent.questionDotToken &&
        nativeListSearch(read.name.text, parent.name.text)
    );
}

/** Whether a type is the pin's ShaderMaterial, or an intersection holding it. */
export function isShaderMaterialType(type: ts.Type): boolean {
    return type.isIntersection()
        ? type.types.some(isShaderMaterialType)
        : isPinnedType(type, ["ShaderMaterial"]);
}

/**
 * Reads of a ShaderMaterial's built fields the native declaration lists do
 * not lower, and `createMaterialView` calls.
 */
const factReads = sourceFilesWalk(
    (
        node: ts.Node,
        symbols: ShaderDerivationContext["symbols"],
        checker: ts.TypeChecker,
    ) =>
        (ts.isCallExpression(node) &&
            symbols.importedName(node.expression) === "createMaterialView") ||
        (ts.isPropertyAccessExpression(node) &&
            shaderMaterialField(node.name.text)?.built &&
            !readsNativeDeclarationList(node) &&
            isShaderMaterialType(checker.getTypeAtLocation(node.expression)))
            ? node
            : undefined,
);

/**
 * Whether shader material creations keep the options they read: the program
 * derives a material from a recipe, reads a field the pin builds from the
 * options, or views a material.
 */
export function keepsShaderCreations(
    context: Pick<ShaderDerivationContext, "checker" | "program" | "symbols">,
): boolean {
    return (
        derivesShaderMaterials(context) ||
        factReads(
            context.program.getSourceFiles(),
            context.symbols,
            context.checker,
        ).length > 0
    );
}

const shaderMaterialModule = "src/material/shader/shader-material.ts";

/** @unjournaled Pure functions of facts nothing writes once recorded. */
const pinnedFields = new WeakMap<RecordFacts, Map<string, DataFact | string>>();

/**
 * A field of the ShaderMaterial the pin's `createShaderMaterial` builds
 * from options `facts`, as plain data, with the run-time leaves of the
 * members it copies (`copies`) where it copies them; a string says why
 * generation does not hold it. The pin runs over the options it validates
 * whatever it builds and the ones the field reads (`SHADER_MATERIAL_FIELDS`).
 */
export function pinnedShaderMaterialField(
    facts: RecordFacts,
    field: string,
): DataFact | string {
    let fields = pinnedFields.get(facts);
    if (!fields) {
        fields = new Map();
        pinnedFields.set(facts, fields);
    }
    const known = fields.get(field);
    if (known !== undefined) return known;
    const built = shaderMaterialField(field)!;
    const read = [
        ...Object.values(SHADER_MATERIAL_FIELDS).flatMap((candidate) =>
            candidate.required ? [candidate.option] : [],
        ),
        ...(built.reads ?? [built.option]),
    ];
    const options: Record<string, unknown> = {};
    /** The copied members holding run-time leaves, by item index. */
    let copied: ReadonlyMap<number, unknown> = new Map();
    let result: DataFact | string | undefined;
    for (const key of read) {
        const fact = facts.get(key);
        if (fact === undefined || fact === "undefined") continue;
        if (fact !== "runtime" && "json" in fact) {
            options[key] = fact.json;
            continue;
        }
        const items =
            fact !== "runtime" && key === built.option
                ? copiedLeaves(fact.partial, built.copies)
                : undefined;
        if (!items) {
            result = `its '${key}' option is decided at run time`;
            break;
        }
        options[key] = items.options;
        copied = items.copied;
    }
    if (result === undefined) {
        const material = pinnedModuleFunction(
            shaderMaterialModule,
            "createShaderMaterial",
        )(options);
        const value: unknown =
            typeof material === "object" && material !== null
                ? Reflect.get(material, field)
                : undefined;
        if (value === undefined)
            throw new Error(
                `Pinned createShaderMaterial no longer builds '${field}'.`,
            );
        for (const [index, member] of copied) {
            const item: unknown = Array.isArray(value)
                ? value[index]
                : undefined;
            const key = built.copies;
            if (
                key === undefined ||
                typeof item !== "object" ||
                item === null ||
                !Object.hasOwn(item, key)
            )
                throw new Error(
                    `Pinned createShaderMaterial no longer copies '${String(key)}' into '${field}' item by item.`,
                );
            Reflect.set(item, key, member);
        }
        result = dataFact(copyPlainData(value));
    }
    fields.set(field, result);
    return result;
}

/**
 * A declaration list whose run-time leaves all sit in the member `member`
 * of its items: the list the pin runs over, each such member `undefined`
 * (the pin builds the rest without it), and the members themselves by item
 * index. Undefined where a leaf sits elsewhere.
 */
function copiedLeaves(
    list: unknown,
    member: string | undefined,
):
    | { readonly options: unknown[]; readonly copied: Map<number, unknown> }
    | undefined {
    if (!Array.isArray(list) || member === undefined) return undefined;
    const copied = new Map<number, unknown>();
    const options = list.map((item: unknown, index): unknown => {
        if (!holdsRuntimeLeaf(item)) return item;
        if (
            typeof item !== "object" ||
            item === null ||
            Array.isArray(item) ||
            !Object.entries(item).every(
                ([key, value]) => key === member || !holdsRuntimeLeaf(value),
            )
        )
            return notJson;
        copied.set(index, Reflect.get(item, member));
        return { ...item, [member]: undefined };
    });
    return options.includes(notJson) ? undefined : { options, copied };
}

/**
 * The facts of an options object `createShaderMaterial` read: its own keys
 * as `objectProperty` resolves them, with the members the compile already
 * settled (`known`) taken from there.
 */
export function shaderOptionFacts(
    context: Pick<
        ShaderDerivationContext,
        | "checker"
        | "compileValue"
        | "evaluationOrder"
        | "objectProperties"
        | "objectProperty"
        | "probeEmission"
        | "program"
        | "propertyName"
        | "resolveStaticLiteral"
        | "staticListItems"
    >,
    object: ts.ObjectLiteralExpression,
    known: Readonly<Record<string, RecordFact>>,
): RecordFacts {
    const keys = new Set<string>();
    for (const member of objectLiteralMembers(
        context.objectProperties(object),
        (name) => context.propertyName(name),
    ))
        if (
            (member.kind === "property" || member.kind === "shorthand") &&
            member.key !== undefined
        )
            keys.add(member.key);
    const facts = new Map<string, RecordFact>();
    for (const key of keys) {
        const expression = context.objectProperty(object, key)!;
        facts.set(
            key,
            known[key] ??
                optionFact(context, expression, LISTED_OPTIONS.has(key)),
        );
    }
    return facts;
}

/**
 * What an option's expression holds, read without leaving code behind: a
 * declaration list (`list`) item by item.
 */
export function optionFact(
    context: Pick<
        ShaderDerivationContext,
        | "checker"
        | "compileValue"
        | "evaluationOrder"
        | "probeEmission"
        | "program"
        | "resolveStaticLiteral"
        | "staticListItems"
    >,
    expression: ts.Expression,
    list: boolean,
): RecordFact {
    return list
        ? listFact(context, expression)
        : expressionFact(context, expression);
}

/** What `read` finds, read without leaving code behind; a refusal is a value only the run time holds. */
function probedFact(
    context: Pick<ShaderDerivationContext, "probeEmission">,
    read: () => RecordFact,
): RecordFact {
    return context.probeEmission(
        () => unlessRefused(read) ?? "runtime",
        () => false,
    );
}

/** A stage's text as a fact: a text that lifts run-time numbers into uniforms is the run time's. */
export function sourceTextFact(text: ShaderSourceText): RecordFact {
    return text.dynamicUniforms.length > 0 ? "runtime" : { json: text.source };
}

/** The WGSL a source expression compiles to, read without leaving code behind. */
export function shaderSourceFact(
    context: Pick<LoweringServices, "compileShaderSource" | "probeEmission">,
    expression: ts.Expression,
    stage: ShaderStage,
): RecordFact {
    return probedFact(context, () =>
        sourceTextFact(context.compileShaderSource(expression, stage)),
    );
}

/** What a member's expression holds, read without leaving code behind. */
function expressionFact(
    context: Pick<
        ShaderDerivationContext,
        "compileValue" | "probeEmission" | "resolveStaticLiteral"
    >,
    expression: ts.Expression,
): RecordFact {
    return probedFact(context, () => {
        const json = staticJsonValue(
            {
                resolveStaticExpression: (node) =>
                    context.resolveStaticLiteral(node),
            },
            expression,
        );
        if (json !== notJson) return { json };
        return absenceOf(context.compileValue(expression)) === "undefined"
            ? "undefined"
            : "runtime";
    });
}

/**
 * A declaration list's items, each read within the bindings it was spelled
 * in: a part generation does not hold is a `RuntimeLeaf` where it is one
 * (`runtimeLeaf`).
 */
function listFact(
    context: Pick<
        ShaderDerivationContext,
        | "checker"
        | "compileValue"
        | "evaluationOrder"
        | "probeEmission"
        | "program"
        | "resolveStaticLiteral"
        | "staticListItems"
    >,
    expression: ts.Expression,
): RecordFact {
    return probedFact(context, () => {
        if (absenceOf(context.compileValue(expression)) === "undefined")
            return "undefined";
        const items = context.staticListItems(expression).map((item) =>
            item.within(
                (): unknown =>
                    item.text ??
                    staticJsonValue(
                        {
                            resolveStaticExpression: (node) =>
                                context.resolveStaticLiteral(node),
                        },
                        item.node,
                        (node) => runtimeLeaf(context, node),
                    ),
            ),
        );
        if (items.includes(notJson)) return "runtime";
        return dataFact(items);
    });
}

/**
 * What a part of a declaration list only the run time holds is as a leaf:
 * a number, or an array of numbers, shared where something other than the
 * list may write its elements once the list holds it (it is no fresh
 * literal, and a write reaches arrays of its type).
 */
function runtimeLeaf(
    context: Pick<
        ShaderDerivationContext,
        "checker" | "evaluationOrder" | "program"
    >,
    expression: ts.Expression,
): RuntimeLeaf | typeof notJson {
    const type = context.checker.getTypeAtLocation(expression);
    if (holdsOnly(type, ["number"])) return new RuntimeLeaf(false);
    const shape = arrayShape(context.checker, type);
    if (!shape || !holdsOnly(shape.element, ["number"])) return notJson;
    const written =
        ts.isArrayLiteralExpression(unwrapExpression(expression)) ||
        !shape.mutable
            ? undefined
            : arrayWriteObservation(context, type, type, expression);
    return new RuntimeLeaf(
        true,
        written && `'${expression.getText()}': ${written}`,
    );
}

/** The binding an options argument names, when it holds one object for its scope. */
export function optionsBinding(
    context: Pick<
        ShaderDerivationContext,
        "bindings" | "checker" | "symbols" | "unwrap"
    >,
    argument: ts.Expression,
): ShaderCreation["binding"] {
    const name = context.unwrap(argument);
    if (!ts.isIdentifier(name)) return undefined;
    const symbol = context.symbols.valueSymbol(name);
    const scope = context.bindings.scopeOf(name);
    const declaration = symbol?.valueDeclaration;
    if (!symbol || !scope || !declaration) return undefined;
    const fixed = ts.isParameter(declaration)
        ? ts.isIdentifier(declaration.name) &&
          !declaration.dotDotDotToken &&
          isSupportedFunction(declaration.parent) &&
          !parameterIsRebound(
              context.checker,
              declaration.parent,
              declaration.name,
          )
        : ts.isVariableDeclaration(declaration) &&
          variableKind(declaration) === "const";
    return fixed ? { symbol, scope } : undefined;
}

/** @unjournaled Pure functions of the checked program. */
const aliasFreeMaps = new WeakMap<ts.Symbol, boolean>();

/**
 * The `const` map a receiver names when every reference to it calls its
 * `get`, `set`, `has` or `delete`: no other name can store into it.
 */
function recipeMap(
    context: Pick<
        ShaderDerivationContext,
        "checker" | "program" | "symbols" | "unwrap"
    >,
    receiver: ts.Expression,
): ts.Symbol | undefined {
    const name = context.unwrap(receiver);
    if (!ts.isIdentifier(name)) return undefined;
    const symbol = context.symbols.valueSymbol(name);
    const declaration = symbol?.valueDeclaration;
    if (
        !symbol ||
        !declaration ||
        !ts.isVariableDeclaration(declaration) ||
        variableKind(declaration) !== "const"
    )
        return undefined;
    let aliasFree = aliasFreeMaps.get(symbol);
    if (aliasFree === undefined) {
        aliasFree =
            directMapCalls(context, symbol)?.every((call) =>
                ["get", "set", "has", "delete"].includes(
                    namedMember(context.checker, call.expression)!.name,
                ),
            ) === true;
        aliasFreeMaps.set(symbol, aliasFree);
    }
    return aliasFree ? symbol : undefined;
}

type RecipeLookupContext = Pick<
    ShaderDerivationContext,
    | "bindings"
    | "checker"
    | "hasStableNativeBinding"
    | "program"
    | "symbols"
    | "unwrap"
>;

/**
 * A map's `get` (`read`): a proved side table supplies its creation's facts;
 * otherwise the native read remains. A recipe map's native read carries
 * the map and material it was keyed by (`shaderRecipeLookup`).
 */
export function readShaderRecipe(
    context: RecipeLookupContext &
        Pick<ShaderDerivationContext, "cppString" | "fail" | "sceneManifest">,
    receiver: ts.Expression,
    key: Value,
    keyNode: ts.Expression,
    read: () => Value,
): Value {
    const variants = shaderVariantsOf(key);
    const variant = variants?.length === 1 ? variants[0] : undefined;
    if (
        key.kind === "material" &&
        variant !== undefined &&
        context.sceneManifest.shaderDerivations.creationsOf(variant).length > 0
    ) {
        const table = shaderSideTable(context, receiver);
        if (table && !table.refusal) {
            // A view has its own identity; registrations only accept actual
            // createShaderMaterial results, not their views.
            if (key.shaderMaterialView) return undefinedValue();
            const fact = key.shaderCreation?.sideTables
                ? (key.shaderCreation.sideTables.get(table.map) ?? {
                      absent: true as const,
                  })
                : context.sceneManifest.shaderDerivations.readSideTable(
                      table.map,
                      variant,
                  );
            // A native get remains valid when generation cannot hold its
            // entry. A required-generation consumer reports the missing proof.
            if (!("refusal" in fact))
                return "absent" in fact
                    ? undefinedValue()
                    : jsonToValue(
                          context,
                          recipeFactPolicy,
                          fact.value,
                          keyNode,
                      );
        }
    }
    const lookup = shaderRecipeLookup(context, receiver, key, keyNode);
    const value = read();
    return lookup
        ? valueForKind(value.kind, { ...value, shaderRecipeLookup: lookup })
        : value;
}

/**
 * What a recipe map's `get` yields beside its value: the map and the
 * material it was keyed by, read from storage nothing reassigns or, for a
 * key no stable binding names (a loop's element), from a constant the
 * lookup pins it to where it reads it.
 */
function shaderRecipeLookup(
    context: RecipeLookupContext,
    receiver: ts.Expression,
    key: Value,
    keyNode: ts.Expression,
): ShaderRecipeLookup | undefined {
    if (
        key.kind !== "material" ||
        key.engineCpp === undefined ||
        !derivesShaderMaterials(context)
    )
        return undefined;
    const map = recipeMap(context, receiver);
    if (!map) return undefined;
    const held = context.hasStableNativeBinding(key)
        ? key
        : context.bindings.pinValueToTemporary(key, "recipe_key", keyNode);
    return { map, materialCpp: held.cpp, engineCpp: key.engineCpp };
}

/**
 * Records a creation-owned side-table value when proved, and a recipe
 * map's `set`: the key's variant, the member holding the options its
 * material was created from, and the record's other members.
 * A store whose options are not provably the key's creation options, or
 * whose records the program may change, makes the map's recipes unknown.
 */
export function recordShaderRecipeStore(
    context: RecipeStoreContext &
        Pick<LoweringServices, "conditions" | "probeEmission">,
    receiver: ts.Expression,
    key: Value,
    stored: ts.Expression,
    value: Value,
    node: ts.Node,
): void {
    if (key.kind === "material" && key.shaderCreation?.sideTables) {
        const table = shaderSideTable(context, receiver);
        if (table && !table.refusal) {
            const creation = key.shaderCreation;
            creation.sideTables!.set(
                table.map,
                sideTableStoreFact(context, table, creation.site, node, () => {
                    const json = context.staticLiteralData(value, stored);
                    const type = mapTypeArguments(
                        context.checker,
                        receiver,
                    )?.[1];
                    return {
                        json,
                        written:
                            type && json !== undefined
                                ? writtenFact(context, type, json, new Set())
                                : undefined,
                    };
                }),
            );
        }
    }
    if (key.kind !== "material" || !derivesShaderMaterials(context)) return;
    const map = recipeMap(context, receiver);
    if (!map) return;
    context.sceneManifest.shaderDerivations.recordStore(
        map,
        recipeStore(context, receiver, key, stored, value),
        node,
        context,
    );
}

function recipeStore(
    context: RecipeStoreContext,
    receiver: ts.Expression,
    key: Value,
    stored: ts.Expression,
    value: Value,
): RecipeStore | string {
    const creation = key.shaderCreation;
    const variant =
        key.sceneShaderVariant === undefined
            ? -1
            : context.sceneManifest.reachedShaderPrograms.findIndex(
                  (program) => program.name === key.sceneShaderVariant,
              );
    if (!creation?.binding || variant < 0)
        return "its key's shader variant or creation options are decided at run time";
    const literal = context.unwrap(stored);
    const member = ts.isObjectLiteralExpression(literal)
        ? objectLiteralMembers(literal, (name) =>
              context.propertyName(name),
          ).find((member) => {
              const named =
                  member.kind === "property" || member.kind === "shorthand"
                      ? context.unwrap(member.value)
                      : undefined;
              return (
                  named !== undefined &&
                  ts.isIdentifier(named) &&
                  context.symbols.valueSymbol(named) ===
                      creation.binding!.symbol &&
                  context.bindings.scopeOf(named) === creation.binding!.scope
              );
          })
        : undefined;
    const memberName =
        member?.kind === "property" || member?.kind === "shorthand"
            ? member.key
            : undefined;
    if (memberName === undefined || value.kind !== "record")
        return "no member of its record is the options its key was created from";
    const properties = value.recordProperties ?? {};
    const members = new Map<string, RecordFact>();
    for (const name of value.recordOwnKeys ?? Object.keys(properties)) {
        if (name === memberName) continue;
        const property = properties[name];
        if (!property)
            return `its member '${name}' is not one generation holds`;
        const json = property.conditionalOwnKey
            ? undefined
            : context.staticLiteralData(property, stored);
        members.set(
            name,
            absenceOf(property) === "undefined"
                ? "undefined"
                : json === undefined
                  ? "runtime"
                  : { json },
        );
    }
    const recipeType = mapTypeArguments(context.checker, receiver)?.[1];
    const written =
        recipeType &&
        writtenFact(context, recipeType, {
            ...Object.fromEntries(
                [...members].flatMap(([name, fact]) =>
                    typeof fact === "object" && "json" in fact
                        ? [[name, fact.json]]
                        : [],
                ),
            ),
            [memberName]: Object.fromEntries(
                [...creation.options].flatMap(([name, fact]) =>
                    typeof fact === "object" && "json" in fact
                        ? [[name, fact.json]]
                        : [],
                ),
            ),
        });
    if (!recipeType || written)
        return `the program may write ${written ?? "its records"}`;
    return { variant, member: memberName, options: creation.options, members };
}

/** The key and value types of the map a receiver names. */
function mapTypeArguments(
    checker: ts.TypeChecker,
    receiver: ts.Expression,
): readonly ts.Type[] | undefined {
    const type = checker.getNonNullableType(
        checker.getTypeAtLocation(receiver),
    );
    return isTypeReference(type) ? checker.getTypeArguments(type) : undefined;
}

/**
 * The first library `get` of a map keyed by ShaderMaterial whose entry
 * `expression` reads: among its operands, through the initializers of the
 * `const` bindings it names and the returns of the source functions it
 * calls. `include` can exclude entries the current variant's side-table
 * facts already supply; their reads are not the cause of a refusal.
 */
export function materialKeyedMapRead(
    context: Pick<ShaderDerivationContext, "checker" | "symbols" | "unwrap">,
    expression: ts.Expression,
    include: (
        read: ts.CallExpression,
        receiver: ts.Expression,
    ) => boolean = () => true,
): ts.CallExpression | undefined {
    const { checker } = context;
    const visited = new Set<ts.Node>();
    const visit = (node: ts.Node): ts.CallExpression | undefined => {
        if (visited.has(node) || ts.isFunctionLike(node)) return undefined;
        visited.add(node);
        if (ts.isIdentifier(node)) {
            const initializer = isValueReference(node)
                ? constInitializer(context, node)
                : undefined;
            return initializer && visit(initializer);
        }
        if (ts.isCallExpression(node)) {
            const callee = namedMember(
                checker,
                context.unwrap(node.expression),
            );
            const key =
                callee?.name === "get" &&
                calledOrigin(checker, node) === "default-lib"
                    ? mapTypeArguments(checker, callee.expression)?.[0]
                    : undefined;
            if (
                key &&
                isShaderMaterialType(key) &&
                include(node, callee!.expression)
            )
                return node;
            const fn = calledFunction(checker, node);
            if (fn?.body && !visited.has(fn)) {
                visited.add(fn);
                const returned: ts.Expression[] = [];
                if (ts.isBlock(fn.body))
                    forEachReturn([fn.body], ({ expression }) => {
                        if (expression) returned.push(expression);
                    });
                else returned.push(fn.body);
                for (const value of returned) {
                    const found = visit(value);
                    if (found) return found;
                }
            }
        }
        return ts.forEachChild(node, visit);
    };
    return visit(expression);
}

/**
 * What the program may write of an object graph whose plain data generation
 * holds (`json`, read as `type`), or undefined when nothing can: a named
 * property of a record type declaring it, a key of a map type holding keys,
 * or the elements of an array the record does not declare readonly (only
 * an assertion makes a readonly one writable). Side-table data also checks
 * observed identities, once per type (`identities` holds the types checked):
 * a generation copy cannot stand for such an object.
 */
function writtenFact(
    context: Pick<
        ShaderDerivationContext,
        "checker" | "evaluationOrder" | "program"
    >,
    type: ts.Type,
    json: unknown,
    identities?: Set<ts.Type>,
): string | undefined {
    if (json === null || typeof json !== "object") return undefined;
    const { checker } = context;
    if (identities && !identities.has(type)) {
        identities.add(type);
        if (
            sourceTypeHasObservedIdentity(
                checker,
                type,
                programObservations(context.program).identities,
            )
        )
            return `or observe the identity of ${checker.typeToString(type)}`;
    }
    for (const member of presentMembers(type)) {
        if (Array.isArray(json)) {
            if (!checker.isArrayType(member) && !checker.isTupleType(member))
                continue;
            if (
                arrayShape(checker, member)?.mutable !== false &&
                arrayWriteObservation(context, member, member)
            )
                return `the elements of ${checker.typeToString(member)}`;
            const elements = checker.getTypeArguments(
                member as ts.TypeReference,
            );
            for (const [index, item] of json.entries()) {
                const element = checker.isTupleType(member)
                    ? elements[index]
                    : elements[0];
                const nested =
                    element && writtenFact(context, element, item, identities);
                if (nested) return nested;
            }
            continue;
        }
        if (
            (member.flags & ts.TypeFlags.Object) === 0 ||
            checker.isArrayType(member) ||
            callSignatures(checker, member, "exact").length > 0
        )
            continue;
        const properties = checker.getPropertiesOfType(member);
        const record = json as Record<string, unknown>;
        if (properties.length === 0) {
            const index = checker.getIndexInfosOfType(member)[0];
            if (!index) continue;
            if (
                Object.keys(record).length > 0 &&
                recordKeysAreWritten(context, member)
            )
                return `keys of ${checker.typeToString(member)}`;
            for (const item of Object.values(record)) {
                const nested = writtenFact(
                    context,
                    index.type,
                    item,
                    identities,
                );
                if (nested) return nested;
            }
            continue;
        }
        for (const property of properties) {
            if (recordFieldIsWritten(context, member, property.name))
                return `'${property.name}' of ${checker.typeToString(member)}`;
            if (!Object.hasOwn(record, property.name)) continue;
            const nested = writtenFact(
                context,
                checker.getTypeOfSymbol(property),
                record[property.name],
                identities,
            );
            if (nested) return nested;
        }
    }
    return undefined;
}

/**
 * Whether evaluating an options literal writes nothing and runs no code with
 * effects; the pin's `wgsl` tag returns its text, so its spans are what run.
 * Generation evaluates it in place of the run time: one that throws there
 * refuses, so a `throw` it may reach is no effect (`completing`).
 */
export function effectFreeOptions(
    context: Pick<ShaderDerivationContext, "evaluationOrder" | "symbols">,
    object: ts.ObjectLiteralExpression,
): boolean {
    const effectFree = (node: ts.Expression): boolean => {
        const template = context.symbols.pinnedWgslTemplate(node);
        if (template)
            return ts.isNoSubstitutionTemplateLiteral(template)
                ? true
                : template.templateSpans.every(({ expression }) =>
                      effectFree(expression),
                  );
        return (
            !context.evaluationOrder.writesStorage(node) &&
            !context.evaluationOrder.hasModuleEffects(node, "completing")
        );
    };
    return objectLiteralMembers(object).every((member) =>
        member.kind === "spread"
            ? effectFree(member.node.expression)
            : member.kind === "property"
              ? !ts.isComputedPropertyName(member.node.name) &&
                effectFree(member.value)
              : member.kind === "shorthand",
    );
}

/** A spread of one member of a recipe a recipe map's `get` yielded. */
interface RecipeSpread {
    readonly spread: ts.SpreadAssignment;
    readonly root: ts.Identifier;
    readonly member: string;
    readonly lookup: ShaderRecipeLookup;
}

/** The options' spread of a recipe member, when they spread one. */
export function derivedRecipeSpread(
    context: Pick<ShaderDerivationContext, "bindings" | "unwrap">,
    object: ts.ObjectLiteralExpression,
): RecipeSpread | undefined {
    for (const member of objectLiteralMembers(object)) {
        if (member.kind !== "spread") continue;
        const access = context.unwrap(member.node.expression);
        if (!ts.isPropertyAccessExpression(access) || access.questionDotToken)
            continue;
        const root = context.unwrap(access.expression);
        const lookup = ts.isIdentifier(root)
            ? context.bindings.lookupOptional(root)?.shaderRecipeLookup
            : undefined;
        if (lookup && ts.isIdentifier(root))
            return {
                spread: member.node,
                root,
                member: access.name.text,
                lookup,
            };
    }
    return undefined;
}

/** Why a derivation refuses, at `node`. */
interface DerivationRefusals {
    readonly node: ts.Node;
    /** Options that lift run-time numbers into uniforms, or, where `opaque`, a transmissive program. */
    readonly runtime: string;
    /** Two programs derived from one source variant. */
    readonly twice: string;
    readonly opaque?: true;
}

/**
 * The program `options` compile to from generation-known options, the
 * binding `binding` names holding source variant `source`'s compile-time
 * record: one per source variant, kept in `derived` by source variant id.
 */
export function compileVariantProgram(
    context: Pick<
        ShaderDerivationContext,
        "bindings" | "captureEmittedLines" | "fail" | "intrinsicOptions"
    >,
    derived: Map<number, CompiledShaderMaterialOptions>,
    source: number,
    binding: { readonly name: ts.Identifier; readonly value: Value },
    options: ts.ObjectLiteralExpression,
    refusals: DerivationRefusals,
): CompiledShaderMaterialOptions {
    let compiled!: CompiledShaderMaterialOptions;
    context.captureEmittedLines(() => {
        compiled = context.bindings.withBoundParameters(
            [{ ...binding, compileTime: true }],
            () =>
                context.intrinsicOptions.compileShaderMaterialOptions(options),
        );
    });
    if (compiled.dynamicUniforms || (refusals.opaque && compiled.transmissive))
        context.fail(refusals.node, refusals.runtime);
    const previous = derived.get(source);
    if (previous && previous.id !== compiled.id)
        context.fail(refusals.node, refusals.twice);
    derived.set(source, compiled);
    return compiled;
}

/**
 * Facts as the compile-time record a synthesized options literal reads:
 * each `extra` member first, plain data as itself, an absent member as
 * `undefined`, and a member the run time holds, whole or in part, as
 * `runtime` reads it.
 */
export function factsRecord(
    context: Pick<ShaderDerivationContext, "cppString" | "fail">,
    facts: RecordFacts,
    node: ts.Node,
    runtime?: (key: string) => Value,
    extra: Readonly<Record<string, Value>> = {},
): Value {
    return {
        kind: "record",
        cpp: "",
        recordOwnKeys: [...Object.keys(extra), ...facts.keys()],
        recordProperties: {
            ...extra,
            ...Object.fromEntries(
                [...facts].map(([key, fact]) => {
                    if (fact === "undefined") return [key, undefinedValue()];
                    if (typeof fact === "object" && "json" in fact)
                        return [
                            key,
                            jsonToValue(
                                context,
                                recipeFactPolicy,
                                fact.json,
                                node,
                            ),
                        ];
                    if (!runtime)
                        throw new Error(
                            `Options generation compiles hold a run-time '${key}'.`,
                        );
                    return [key, runtime(key)];
                }),
            ),
        },
    };
}

/** The variants a derivation site takes, by source variant, and its creation's variant. */
interface DerivedShaderMaterial {
    readonly variants: ReadonlyMap<number, CompiledShaderMaterialOptions>;
    readonly variantCpp: string;
}

/**
 * A `createShaderMaterial` whose options spread a member of a recipe read
 * from a recipe map (`derivedRecipeSpread`): compiled once per stored
 * source variant, the recipe standing for that store's facts.
 */
export function compileDerivedShaderMaterial(
    context: ShaderDerivationContext,
    object: ts.ObjectLiteralExpression,
): DerivedShaderMaterial {
    const { spread, root, member, lookup } = derivedRecipeSpread(
        context,
        object,
    )!;
    const declaration = context.symbols.valueSymbol(root)?.valueDeclaration;
    if (
        !declaration ||
        !ts.isVariableDeclaration(declaration) ||
        !ts.isIdentifier(declaration.name) ||
        variableKind(declaration) !== "const"
    )
        context.fail(
            spread,
            "A material derived from a recipe reads it through a `const` binding.",
        );
    const recipes = context.sceneManifest.shaderDerivations.recipes(lookup.map);
    if (typeof recipes === "string")
        context.fail(
            spread,
            `A material derived from a recipe map needs every recipe's creation options; one store's are unknown: ${recipes}.`,
        );
    if (recipes.length === 0)
        context.fail(
            spread,
            "A material derived from a recipe map needs the recipe stores to compile before it.",
        );
    // Generation evaluates the options once per source variant; the run
    // time, once for its source.
    if (!effectFreeOptions(context, object))
        context.fail(
            object,
            "A material derived from a recipe evaluates its options at generation, once per source variant; these write storage or run code with effects.",
        );
    const variants = new Map<number, CompiledShaderMaterialOptions>();
    for (const store of recipes) {
        if (store.member !== member)
            context.fail(
                spread,
                `A material derived from a recipe spreads '${member}', which a store of the map does not hold its key's creation options in.`,
            );
        compileVariantProgram(
            context,
            variants,
            store.variant,
            { name: declaration.name, value: recipeView(context, root, store) },
            object,
            {
                node: spread,
                runtime:
                    "A material derived from a recipe compiles from generation-known options per source variant; this one lifts run-time numbers into uniforms or is transmissive.",
                twice: "A material derived from a recipe map derives two variants from one source variant: its stores hold different recipes for materials of one variant.",
                opaque: true,
            },
        );
    }
    return {
        variants,
        variantCpp: context.sceneManifest.shaderDerivations.derivedVariantCpp(
            lookup.map,
            new Map([...variants].map(([source, { id }]) => [source, id])),
            `bbl::shader_material(${lookup.engineCpp}, ${lookup.materialCpp}).shader_variant`,
        ),
    };
}

/**
 * The recipe a store holds, as a compile-time record: plain data as itself,
 * absent members as `undefined`, and what only the run time holds read
 * from the run-time recipe `root` names.
 */
function recipeView(
    context: ShaderDerivationContext,
    root: ts.Identifier,
    store: RecipeStore,
): Value {
    const read = (path: readonly string[]): Value => {
        let owner: ts.Expression = root;
        for (const key of path) {
            const literal = context.memberLiteral(owner, [key]);
            owner = (literal.properties[0] as ts.PropertyAssignment)
                .initializer;
        }
        return context.compileValue(owner);
    };
    return factsRecord(context, store.members, root, (name) => read([name]), {
        [store.member]: factsRecord(context, store.options, root, (name) =>
            read([store.member, name]),
        ),
    });
}
