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
import { bindingReferences } from "./binding-references.js";
import { unlessRefused } from "./compile-error.js";
import {
    emissionArray,
    EmissionMap,
    EmissionSet,
} from "./emission-transaction.js";
import { pinnedModuleFunction } from "../lowering/pinned-shader-builders.js";
import { jsonToValue, type JsonValuePolicy } from "./json-value.js";
import type { LoweringServices } from "./lowering-services.js";
import { staticJsonValue } from "./option-helpers.js";
import { parameterIsRebound } from "./parameter-effects.js";
import {
    arrayWriteObservation,
    recordFieldIsWritten,
    recordKeysAreWritten,
} from "./record-observations.js";
import { sourceFilesWalk } from "./analysis-walk.js";
import {
    functionOfDeclaration,
    notJson,
    objectLiteralMembers,
    outermostWrapper,
    unwrapExpression,
    variableKind,
} from "./syntax.js";
import { isPinnedType } from "./data-types.js";
import { arrayShape, callSignatures, presentMembers } from "./type-facts.js";
import type { CompiledShaderMaterialOptions } from "./shader-material.js";
import type { StaticListItem, Value } from "./types.js";
import { absenceOf, undefinedValue } from "./values/model.js";

/**
 * One own key of a record: plain data generation knows, `undefined`, or a
 * value only the run time holds.
 */
export type RecordFact = { readonly json: unknown } | "undefined" | "runtime";

/** A record's own keys in order, with what each holds. */
export type RecordFacts = ReadonlyMap<string, RecordFact>;

/** What `createShaderMaterial` read its options as, carried by the material. */
export interface ShaderCreation {
    readonly options: RecordFacts;
    /** The binding that named the options object, in the scope that read it. */
    readonly binding?: { readonly symbol: ts.Symbol; readonly scope: object };
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
 * The recipe stores and derivations generation compiled, by map. A store
 * compiled after a derivation of its map refuses: the derivation's variant
 * table is closed by then.
 */
export class ShaderDerivationRecorder {
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

    /** Records the options a variant compiled from, once per distinct reading. */
    public recordCreation(variant: string, options: RecordFacts): void {
        const known = this.creations.get(variant) ?? [];
        const identity = JSON.stringify([...options]);
        if (known.some((facts) => JSON.stringify([...facts]) === identity))
            return;
        this.creations.set(variant, [...known, options]);
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
        const known = this.stores.get(map) ?? [];
        const identity = JSON.stringify(storeIdentity(store));
        if (
            known.some(
                (candidate) =>
                    JSON.stringify(storeIdentity(candidate)) === identity,
            )
        )
            return;
        this.stores.set(map, [...known, store]);
    }

    /** The stores a derivation reads, or why the map's recipes are unknown. */
    public recipes(map: ts.Symbol): readonly RecipeStore[] | string {
        return this.opaque.get(map) ?? this.stores.get(map) ?? [];
    }

    /** A site's table; a recipe map's stores close once one derives from it. */
    public recordSite(
        map: ts.Symbol | undefined,
        variants: ReadonlyMap<number, number>,
    ): number {
        if (map) this.derived.add(map);
        return this.sites.push(variants) - 1;
    }

    /** One function per derivation site, from source variant to derived variant. */
    public functionsCpp(): string[] {
        return this.sites.flatMap((variants, site) => [
            ...(site > 0 ? [""] : []),
            `// The shader variant derivation site ${site} creates from its source material's variant.`,
            `[[maybe_unused]] inline std::uint32_t derived_shader_variant_${site}(std::uint32_t source) {`,
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

function storeIdentity(store: RecipeStore): unknown {
    return [
        store.variant,
        store.member,
        [...store.options],
        [...store.members],
    ];
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
export function derivesShaderMaterials(
    context: Pick<ShaderDerivationContext, "program" | "symbols">,
): boolean {
    return (
        derivationSites(context.program.getSourceFiles(), context.symbols)
            .length > 0
    );
}

/**
 * The ShaderMaterial fields `createShaderMaterial` builds from its options,
 * by the option each is built from.
 */
export const PINNED_SHADER_FIELDS: Readonly<Record<string, string>> = {
    vertexSource: "vertexSource",
    fragmentSource: "fragmentSource",
    uniformDecls: "uniforms",
    samplerDecls: "samplers",
    storageBufferDecls: "storageBuffers",
};

/** Whether a type is the pin's ShaderMaterial, or an intersection holding it. */
export function isShaderMaterialType(type: ts.Type): boolean {
    return type.isIntersection()
        ? type.types.some(isShaderMaterialType)
        : isPinnedType(type, ["ShaderMaterial"]);
}

/** Reads of a ShaderMaterial's built fields, and `createMaterialView` calls. */
const factReads = sourceFilesWalk(
    (
        node: ts.Node,
        symbols: ShaderDerivationContext["symbols"],
        checker: ts.TypeChecker,
    ) =>
        (ts.isCallExpression(node) &&
            symbols.importedName(node.expression) === "createMaterialView") ||
        (ts.isPropertyAccessExpression(node) &&
            Object.hasOwn(PINNED_SHADER_FIELDS, node.name.text) &&
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

/**
 * A field of the ShaderMaterial the pin's `createShaderMaterial` builds
 * from options `facts`, as plain data; a string says why generation does
 * not hold it. The pin runs over the options its validation reads (both
 * sources and the attributes) and `read`, the ones the field is built
 * from: by default the option `PINNED_SHADER_FIELDS` names.
 */
export function pinnedShaderMaterialField(
    facts: RecordFacts,
    field: string,
    read: readonly string[] = [PINNED_SHADER_FIELDS[field]!],
): { readonly json: unknown } | string {
    const options: Record<string, unknown> = {};
    for (const key of [
        "vertexSource",
        "fragmentSource",
        "attributes",
        ...read,
    ]) {
        const fact = facts.get(key);
        if (fact === undefined || fact === "undefined") continue;
        if (fact === "runtime")
            return `its '${key}' option is decided at run time`;
        options[key] = fact.json;
    }
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
    return { json: JSON.parse(JSON.stringify(value)) as unknown };
}

/**
 * The facts of an options object `createShaderMaterial` read: its own keys
 * as `objectProperty` resolves them, with the members the compile already
 * settled (`known`) taken from there.
 */
export function shaderOptionFacts(
    context: Pick<
        ShaderDerivationContext,
        | "compileValue"
        | "objectProperties"
        | "objectProperty"
        | "probeEmission"
        | "propertyName"
        | "resolveStaticLiteral"
        | "staticListItems"
    >,
    object: ts.ObjectLiteralExpression,
    known: Readonly<Record<string, RecordFact>>,
    lists: ReadonlySet<string>,
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
            known[key] ?? optionFact(context, expression, lists.has(key)),
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
        | "compileValue"
        | "probeEmission"
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

/** What a member's expression holds, read without leaving code behind. */
function expressionFact(
    context: Pick<
        ShaderDerivationContext,
        "compileValue" | "probeEmission" | "resolveStaticLiteral"
    >,
    expression: ts.Expression,
): RecordFact {
    return context.probeEmission(
        () =>
            unlessRefused((): RecordFact => {
                const json = staticJsonValue(
                    {
                        resolveStaticExpression: (node) =>
                            context.resolveStaticLiteral(node),
                    },
                    expression,
                );
                if (json !== notJson) return { json };
                return absenceOf(context.compileValue(expression)) ===
                    "undefined"
                    ? "undefined"
                    : "runtime";
            }) ?? "runtime",
        () => false,
    );
}

/** A declaration list's items, each read within the bindings it was spelled in. */
function listFact(
    context: Pick<
        ShaderDerivationContext,
        | "compileValue"
        | "probeEmission"
        | "resolveStaticLiteral"
        | "staticListItems"
    >,
    expression: ts.Expression,
): RecordFact {
    return context.probeEmission(
        () =>
            unlessRefused((): RecordFact => {
                if (absenceOf(context.compileValue(expression)) === "undefined")
                    return "undefined";
                const items = context
                    .staticListItems(expression)
                    .map((item: StaticListItem) => {
                        const read = (): unknown =>
                            item.text ??
                            staticJsonValue(
                                {
                                    resolveStaticExpression: (node) =>
                                        context.resolveStaticLiteral(node),
                                },
                                item.node,
                            );
                        return item.within ? item.within(read) : read();
                    });
                return items.includes(notJson) ? "runtime" : { json: items };
            }) ?? "runtime",
        () => false,
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
          !parameterIsRebound(
              context.checker,
              functionOfDeclaration(declaration)!,
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
        aliasFree = bindingReferences(
            context.program,
            context.checker,
            symbol,
        ).every((reference) => {
            const access = outermostWrapper(reference).parent;
            return (
                ts.isPropertyAccessExpression(access) &&
                ["get", "set", "has", "delete"].includes(access.name.text) &&
                ts.isCallExpression(access.parent) &&
                access.parent.expression === access
            );
        });
        aliasFreeMaps.set(symbol, aliasFree);
    }
    return aliasFree ? symbol : undefined;
}

/**
 * What a recipe map's `get` yields beside its value: the map and the
 * material it was keyed by, read from storage nothing reassigns or, for a
 * key no stable binding names (a loop's element), from a constant the
 * lookup pins it to where it reads it.
 */
export function shaderRecipeLookup(
    context: Pick<
        ShaderDerivationContext,
        | "bindings"
        | "checker"
        | "hasStableNativeBinding"
        | "program"
        | "symbols"
        | "unwrap"
    >,
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
 * Records a recipe map's `set`: the key's variant, the member holding the
 * options its material was created from, and the record's other members.
 * A store whose options are not provably the key's creation options, or
 * whose records the program may change, makes the map's recipes unknown.
 */
export function recordShaderRecipeStore(
    context: RecipeStoreContext,
    receiver: ts.Expression,
    key: Value,
    stored: ts.Expression,
    value: Value,
    node: ts.Node,
): void {
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
    const recipeType = mapValueType(context, receiver);
    const written =
        recipeType &&
        writtenFact(context, recipeType, {
            ...Object.fromEntries(
                [...members].flatMap(([name, fact]) =>
                    typeof fact === "object" ? [[name, fact.json]] : [],
                ),
            ),
            [memberName]: Object.fromEntries(
                [...creation.options].flatMap(([name, fact]) =>
                    typeof fact === "object" ? [[name, fact.json]] : [],
                ),
            ),
        });
    if (!recipeType || written)
        return `the program may write ${written ?? "its records"}`;
    return { variant, member: memberName, options: creation.options, members };
}

/** The value type of the map a receiver names. */
function mapValueType(
    context: Pick<ShaderDerivationContext, "checker">,
    receiver: ts.Expression,
): ts.Type | undefined {
    const type = context.checker.getNonNullableType(
        context.checker.getTypeAtLocation(receiver),
    );
    return (type.flags & ts.TypeFlags.Object) !== 0 &&
        ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0
        ? context.checker.getTypeArguments(type as ts.TypeReference)[1]
        : undefined;
}

/**
 * What the program may write of an object graph whose plain data generation
 * holds (`json`, read as `type`), or undefined when nothing can: a named
 * property of a record type declaring it, a key of a map type holding keys,
 * or the elements of an array the record does not declare readonly (only
 * an assertion makes a readonly one writable).
 */
function writtenFact(
    context: Pick<
        ShaderDerivationContext,
        "checker" | "evaluationOrder" | "program"
    >,
    type: ts.Type,
    json: unknown,
): string | undefined {
    if (json === null || typeof json !== "object") return undefined;
    const { checker } = context;
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
                const nested = element && writtenFact(context, element, item);
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
                const nested = writtenFact(context, index.type, item);
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
            );
            if (nested) return nested;
        }
    }
    return undefined;
}

/**
 * Whether evaluating an options literal writes nothing and runs no code with
 * effects; the pin's `wgsl` tag returns its text, so its spans are what run.
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
            !context.evaluationOrder.hasModuleEffects(node)
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

/** The variants a derivation site takes, by source variant. */
export interface DerivedShaderMaterial {
    readonly variants: ReadonlyMap<number, { name: string; id: number }>;
    readonly lookup: ShaderRecipeLookup;
    readonly site: number;
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
    const variants = new Map<number, { name: string; id: number }>();
    for (const store of recipes) {
        if (store.member !== member)
            context.fail(
                spread,
                `A material derived from a recipe spreads '${member}', which a store of the map does not hold its key's creation options in.`,
            );
        const view = recipeView(context, root, store);
        let derived!: CompiledShaderMaterialOptions;
        context.captureEmittedLines(() => {
            derived = context.bindings.withBoundParameters(
                [
                    {
                        name: declaration.name as ts.Identifier,
                        value: view,
                        compileTime: true,
                    },
                ],
                () =>
                    context.intrinsicOptions.compileShaderMaterialOptions(
                        object,
                    ),
            );
        });
        if (derived.dynamicUniforms || derived.transmissive)
            context.fail(
                spread,
                "A material derived from a recipe compiles from generation-known options per source variant; this one lifts run-time numbers into uniforms or is transmissive.",
            );
        const previous = variants.get(store.variant);
        if (previous && previous.id !== derived.id)
            context.fail(
                spread,
                "A material derived from a recipe map derives two variants from one source variant: its stores hold different recipes for materials of one variant.",
            );
        variants.set(store.variant, { name: derived.name, id: derived.id });
    }
    const site = context.sceneManifest.shaderDerivations.recordSite(
        lookup.map,
        new Map([...variants].map(([source, { id }]) => [source, id])),
    );
    return { variants, lookup, site };
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
    const record = (
        facts: RecordFacts,
        path: readonly string[],
        extra: Readonly<Record<string, Value>> = {},
    ): Value => ({
        kind: "record",
        cpp: "",
        recordOwnKeys: [...Object.keys(extra), ...facts.keys()],
        recordProperties: {
            ...extra,
            ...Object.fromEntries(
                [...facts].map(([name, fact]) => [
                    name,
                    fact === "undefined"
                        ? undefinedValue()
                        : fact === "runtime"
                          ? read([...path, name])
                          : jsonToValue(
                                context,
                                recipeFactPolicy,
                                fact.json,
                                root,
                            ),
                ]),
            ),
        },
    });
    return record(store.members, [], {
        [store.member]: record(store.options, [store.member]),
    });
}
