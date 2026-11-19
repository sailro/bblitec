// A ShaderMaterial's built fields, read at generation, and the material
// views derived from them.
//
// The pin's `createShaderMaterial` builds `vertexSource`, `fragmentSource`,
// `uniformDecls`, `samplerDecls` and `storageBufferDecls` from its options,
// so a material whose shader variant generation knows reads each as the
// plain data the pin builds from that variant's options. Its slot maps
// (`_uniformValues`, `_textureSlots`, `_storageBufferSlots`) hold the
// values and resources bound at run time: a read copies the slot objects,
// which keep their identity, and a view given maps of its own slots by
// `Object.defineProperties` installs them (`install_shader_view_slots`).
//
// `createMaterialView(source, { features: 0 })` is an object inheriting the
// source. A program property an `Object.defineProperty` or
// `Object.defineProperties` statement redefines on it makes the view draw
// another program: compiled once per variant the source may have, from
// that variant's options with the redefinitions over them, and selected at
// run time from the view's variant (`derived_shader_variant_<site>`). The
// view keeps the source's slots, so a redefinition keeps the uniforms,
// samplers and storage buffers its source declares, and its program takes
// no uniform defaults (`viewProgramFact`).
import ts from "typescript";
import { writable } from "./emission-transaction.js";
import { jsonToValue } from "./json-value.js";
import type { LoweringServices } from "./lowering-services.js";
import {
    compileVariantProgram,
    effectFreeOptions,
    factsRecord,
    fieldsReadingOthers,
    holdsRuntimeLeaf,
    isShaderMaterialType,
    optionFact,
    optionsBinding,
    pinnedShaderMaterialField,
    recipeFactPolicy,
    runTimeFact,
    shaderMaterialField,
    shaderSourceFact,
    RuntimeLeaf,
    UnreadableLeaf,
    unreadableFactRefusal,
    viewDefinitionFact,
    viewFields,
    viewProgramFact,
    type RecordFact,
    type RecordFacts,
    type ShaderDerivationContext,
} from "./shader-derivations.js";
import type { CompiledShaderMaterialOptions } from "./shader-material.js";
import {
    shaderUniformValueLayout,
    typeComponents,
} from "../shader-material-programs.js";
import { bindingReferences } from "./binding-references.js";
import { bindingRebinds } from "./binding-rebinds.js";
import { callTarget } from "./parameter-effects.js";
import { someAnalysisNode } from "./analysis-walk.js";
import { isGlobalUndefined, isLibraryStatic } from "./symbols.js";
import {
    isSupportedFunction,
    isAsyncFunction,
    functionOfDeclaration,
    outermostWrapper,
    statementsBeside,
    unwrapExpression,
    variableKind,
} from "./syntax.js";
import type { DataStructField } from "./data-types.js";
import type { DataType } from "./data-types/model.js";
import type { CompiledShaderProgram, Value } from "./types.js";
import {
    shaderVariantFacts,
    shaderVariantsOf,
    unreadableRefusal,
    unreadableValue,
    valueDataType,
    withShaderVariants,
} from "./values/model.js";
import { unlessRefused } from "./compile-error.js";

/** A `createMaterialView` over a ShaderMaterial. */
export interface ShaderMaterialView {
    /** The source material as the view read it. */
    readonly source: Value;
    /** The declaration of the binding naming the source, when nothing rebinds it. */
    readonly sourceName?: ts.Identifier;
    /** Each program the view may draw, by variant name, to the source variant it derives from. */
    readonly programs: ReadonlyMap<string, string>;
    /** The programs the view was declared with, before any definition. */
    readonly declared: ReadonlyMap<string, string>;
    /** The programs each definition statement left the view with. */
    readonly defined: ReadonlyMap<ts.Statement, ReadonlyMap<string, string>>;
    /**
     * The source's variant is the run time's, so a program is selected
     * from the view's variant even where one variant is created.
     */
    readonly runtimeSource?: true;
}

export type ShaderMaterialViewContext = Omit<
    ShaderDerivationContext,
    | "hasStableNativeBinding"
    | "objectProperties"
    | "objectProperty"
    | "program"
    | "propertyName"
> &
    Pick<
        LoweringServices,
        | "allocateTemporaryCppName"
        | "compileShaderSource"
        | "dataLowerer"
        | "dataTypes"
        | "emit"
        | "expectArgumentCount"
        | "reachFeature"
        | "requireEngine"
    >;

/**
 * One property a definition call redefines on a view, as object-statics.ts
 * parses its descriptor (`propertyDefinition`).
 */
interface ViewDefinition {
    readonly key: string;
    /** Where the definition is spelled: the call, or its descriptor map's member. */
    readonly site: ts.Node;
    /** The descriptor expression, and the literal it is. */
    readonly node: ts.Node;
    readonly descriptor: ts.ObjectLiteralExpression;
    /** A data descriptor's value; an accessor descriptor has none. */
    readonly value: ts.Expression | undefined;
}

/** A slot map: the declarations its entries follow, and what each entry holds. */
interface SlotMap {
    readonly declarations:
        "uniformDecls" | "samplerDecls" | "storageBufferDecls";
    /** The native `ShaderDeclarationList`. */
    readonly list: "uniforms" | "samplers" | "storage_buffers";
    /** The entry member holding the slot's value or resource, and its data type. */
    readonly held: "value" | "current";
    readonly heldType: DataType;
}

const SLOT_MAPS: Readonly<Record<string, SlotMap>> = {
    _uniformValues: {
        declarations: "uniformDecls",
        list: "uniforms",
        held: "value",
        heldType: { kind: "f32array" },
    },
    _textureSlots: {
        declarations: "samplerDecls",
        list: "samplers",
        held: "current",
        heldType: {
            kind: "optional",
            inner: { kind: "handle", handle: "texture" },
        },
    },
    _storageBufferSlots: {
        declarations: "storageBufferDecls",
        list: "storage_buffers",
        held: "current",
        heldType: {
            kind: "optional",
            inner: { kind: "handle", handle: "storage-buffer" },
        },
    },
};

/** A slot map's entry record as the program types it. */
interface SlotEntryType {
    readonly map: DataType;
    readonly entry: DataType & { kind: "struct" };
    readonly fields: readonly DataStructField[];
}

/**
 * The program's type of a slot map: a `Map` from names to records shared
 * by identity, holding `decl` and the member the slot holds (`SlotMap`) as
 * the pin's slot objects do.
 */
function slotEntryType(
    context: Pick<ShaderMaterialViewContext, "dataTypes" | "fail">,
    map: DataType | undefined,
    slots: SlotMap,
    node: ts.Node,
): SlotEntryType {
    const refuse = (): never =>
        context.fail(
            node,
            `A ShaderMaterial's slot map is a Map from names to records of 'decl' and '${slots.held}' (${context.dataTypes.cppType(slots.heldType)}), as the pin's slot objects are.`,
        );
    if (
        map?.kind !== "map" ||
        map.weak ||
        map.dictionary ||
        map.key.kind !== "string" ||
        map.value.kind !== "struct" ||
        !context.dataTypes.isReferenceStruct(map.value.name)
    )
        return refuse();
    const fields = context.dataTypes.structFields(map.value.name, node);
    if (
        !fields.every(
            (field) =>
                field.sourceName === "decl" ||
                (field.sourceName === slots.held &&
                    context.dataTypes.cppType(field.type) ===
                        context.dataTypes.cppType(slots.heldType)),
        )
    )
        return refuse();
    return { map, entry: map.value, fields };
}

/**
 * Whether a read of a slot map only reads its entries: `get`, `has`,
 * `size`, an iteration or a `new Map` copy. A read copies the material's
 * slots, so a write to it, or a map held to compare, would not be the
 * material's.
 */
function readsSlotEntries(expression: ts.Expression): boolean {
    const node = outermostWrapper(expression);
    const parent = node.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        const name = parent.name.text;
        if (name === "size") return true;
        return (
            ["get", "has", "keys", "values", "entries", "forEach"].includes(
                name,
            ) &&
            ts.isCallExpression(parent.parent) &&
            parent.parent.expression === parent
        );
    }
    if (ts.isForOfStatement(parent)) return parent.expression === node;
    return (
        ts.isNewExpression(parent) &&
        ts.isIdentifier(parent.expression) &&
        parent.expression.text === "Map" &&
        parent.arguments?.length === 1 &&
        parent.arguments[0] === node
    );
}

/**
 * `<material>._uniformValues`, `._textureSlots` or `._storageBufferSlots`:
 * a Map holding one new slot record per declaration of the material's
 * variant (`declarations`, as `readShaderMaterialFact` reads them), each
 * holding what the material's slot holds. A texture or storage slot
 * record's identity is registered as that slot
 * (`register_shader_slot_read`).
 */
function readSlotMap(
    context: Pick<
        ShaderMaterialViewContext,
        | "allocateTemporaryCppName"
        | "cppString"
        | "dataLowerer"
        | "dataTypes"
        | "emit"
        | "fail"
        | "reachFeature"
    >,
    expression: ts.PropertyAccessExpression,
    slots: SlotMap,
    data: unknown,
    declarations: Value,
    material: { readonly engine: string; readonly cpp: string },
): Value {
    const type = slotEntryType(
        context,
        context.dataLowerer.dataTypeAt(expression),
        slots,
        expression,
    );
    const items = Array.isArray(data) ? data : [];
    const decl = type.fields.find((field) => field.sourceName === "decl");
    const held = type.fields.find((field) => field.sourceName === slots.held);
    context.reachFeature("material:shader-slot-maps", expression);
    const map = context.allocateTemporaryCppName("shader_slots");
    context.emit(`${context.dataTypes.cppType(type.map)} ${map}{};`);
    const list = `bbl::ShaderDeclarationList::${slots.list}`;
    items.forEach((item: unknown, index) => {
        const name = String(Reflect.get(Object(item), "name"));
        const declCpp = decl
            ? context.dataLowerer.compileKnownValueForSink(
                  declarations.tupleElements![index]!,
                  decl.type,
                  expression,
              )
            : undefined;
        const heldCpp =
            slots.list === "uniforms"
                ? `bbl::shader_slot_uniform_value(${material.engine}, ${material.cpp}, ${context.cppString(name)}, ${context.cppString(String(Reflect.get(Object(item), "type")))}, ${typeComponents(String(Reflect.get(Object(item), "type")))}u)`
                : `bbl::${slots.list === "samplers" ? "shader_slot_texture" : "shader_slot_storage_buffer"}(${material.engine}, ${material.cpp}, ${index}u)`;
        const entry = context.allocateTemporaryCppName("shader_slot");
        const parts = type.fields.map((field) =>
            context.dataTypes.structFieldInitializerCpp(
                field,
                field === decl ? declCpp! : field === held ? heldCpp : "{}",
            ),
        );
        const register =
            slots.list === "uniforms"
                ? ""
                : ` bbl::register_shader_slot_read(${material.engine}, ${material.cpp}, ${list}, ${index}u, ${entry}.weak_identity());`;
        context.emit(
            `{ auto ${entry} = ${context.dataLowerer.structAggregate(type.entry, parts)};${register} static_cast<void>(${map}.set(${context.cppString(name)}, std::move(${entry}))); }`,
        );
    });
    return context.dataLowerer.leafValue(map, type.map);
}

/** The text a refusal names an expression by. */
function spelled(node: ts.Node): string {
    return node.getSourceFile() ? node.getText() : "the material";
}

/**
 * The one reading of a ShaderMaterial field every variant `variants` names
 * gives, as plain data that may hold run-time leaves (`RuntimeLeaf`), or a
 * refusal naming why generation does not hold it.
 */
function variantsField(
    context: Pick<ShaderMaterialViewContext, "fail" | "sceneManifest">,
    variants: readonly string[],
    field: string,
    node: ts.Node,
): unknown {
    let found: unknown;
    for (const variant of variants) {
        const creations =
            context.sceneManifest.shaderDerivations.creationsOf(variant);
        if (creations.length === 0)
            context.fail(
                node,
                `'${spelled(node)}' reads a ShaderMaterial's '${field}'; the options shader variant '${variant}' was created from are not generation's.`,
            );
        for (const facts of creations) {
            const read = pinnedShaderMaterialField(facts, field);
            if (typeof read === "string")
                context.fail(
                    node,
                    `'${spelled(node)}' reads a ShaderMaterial's '${field}', which generation does not hold for shader variant '${variant}': ${read}.`,
                );
            const data = "json" in read ? read.json : read.partial;
            if (
                found !== undefined &&
                JSON.stringify(found) !== JSON.stringify(data)
            )
                context.fail(
                    node,
                    `'${spelled(node)}' reads a ShaderMaterial's '${field}', which differs between the materials it may be; the run time decides which.`,
                );
            found = data;
        }
    }
    return found;
}

/**
 * A run-time leaf of a uniform's `defaultValue` the field copied
 * (`copies`): the lanes the material's creation initialized the uniform
 * from (`bbl::shader_uniform_creation_lane`), at the offset each variant
 * lays the uniform out at. `path` is the leaf's: item, member, then lane.
 * The pin's field holds the creation's own array, so one the program may
 * change after the creation is a value whose reads refuse
 * (`unreadableValue`): the material keeps only its numbers.
 */
function creationLaneLeaf(
    context: Pick<ShaderMaterialViewContext, "fail" | "sceneManifest">,
    variants: readonly string[],
    data: unknown,
    leaf: RuntimeLeaf,
    path: readonly (string | number)[],
    material: () => { readonly engine: string; readonly cpp: string },
    node: ts.Node,
): Value {
    const [item, , lane] = path;
    const name: unknown = Array.isArray(data)
        ? Reflect.get(Object(data[Number(item)]), "name")
        : undefined;
    if (leaf.shared)
        return unreadableValue(
            `'${spelled(node)}' reads a ShaderMaterial's '${String(path[1])}' of uniform '${String(name)}', the array its creation was given, which the program may change after the creation (${leaf.shared}); the material keeps only that array's numbers at its creation.`,
        );
    const slots = variants.map((variant) => {
        const program = context.sceneManifest.reachedShaderProgram(
            variant,
            node,
        );
        return typeof name === "string"
            ? shaderUniformValueLayout(program.uniforms).get(name)
            : undefined;
    });
    const slot = slots[0];
    if (
        !slot ||
        slots.some(
            (other) =>
                other?.offset !== slot.offset || other.count !== slot.count,
        )
    )
        context.fail(
            node,
            `'${spelled(node)}' reads a ShaderMaterial's uniform default at run time; the materials it may be lay that uniform out differently.`,
        );
    const { engine, cpp } = material();
    const read = (index: number): Value => ({
        kind: "number",
        cpp: `bbl::shader_uniform_creation_lane(${engine}, ${cpp}, ${slot.offset}u, ${index}u)`,
        dataType: { kind: "number" },
    });
    if (!leaf.lanes) return read(typeof lane === "number" ? lane : 0);
    return {
        kind: "tuple",
        cpp: "",
        tupleElements: Array.from({ length: slot.count }, (_, index) =>
            read(index),
        ),
    };
}

/**
 * `<material>.<field>` for a field generation reads as the plain data the
 * pin's `createShaderMaterial` builds (`shaderMaterialField`) or a slot
 * map: the plain data the material's variant was built with, the slots of
 * its declarations (`readSlotMap`), or a refusal. Undefined for any other
 * read.
 */
export function readShaderMaterialFact(
    context: Pick<
        ShaderMaterialViewContext,
        | "allocateTemporaryCppName"
        | "bindings"
        | "checker"
        | "cppString"
        | "dataLowerer"
        | "dataTypes"
        | "emit"
        | "fail"
        | "reachFeature"
        | "requireEngine"
        | "sceneManifest"
    >,
    owner: Value,
    expression: ts.PropertyAccessExpression,
): Value | undefined {
    const name = expression.name.text;
    const slots = Object.hasOwn(SLOT_MAPS, name) ? SLOT_MAPS[name] : undefined;
    if (!shaderMaterialField(name)?.built && !slots) return undefined;
    const material =
        owner.kind === "material" ||
        (owner.dataType?.kind === "handle" &&
            owner.dataType.handle === "material");
    if (
        !material ||
        !isShaderMaterialType(
            context.checker.getTypeAtLocation(expression.expression),
        )
    )
        return undefined;
    if (slots && !readsSlotEntries(expression))
        context.fail(
            expression,
            `'${spelled(expression)}' reads a ShaderMaterial's '${name}' other than by 'get', 'has', 'size', an iteration or a 'new Map' copy; the read copies the material's slots, so a write to it or a map held from it is not the material's.`,
        );
    const variants = shaderVariantsOf(owner);
    if (!variants)
        context.fail(
            expression,
            `'${spelled(expression)}' reads a ShaderMaterial's '${name}', which its shader variant decides; this material's variant is decided at run time.`,
        );
    const field = slots?.declarations ?? name;
    const data = variantsField(context, variants, field, expression);
    // The leaves read the material once, where the field is read.
    let reader: { readonly engine: string; readonly cpp: string } | undefined;
    const readMaterial = (): {
        readonly engine: string;
        readonly cpp: string;
    } => {
        if (!reader) {
            const held = context.bindings.pinValueToTemporary(
                owner,
                "shader_material",
                expression.expression,
            );
            reader = {
                engine: context.requireEngine(held, expression),
                cpp: held.cpp,
            };
        }
        return reader;
    };
    const value = !holdsRuntimeLeaf(data)
        ? jsonToValue(context, recipeFactPolicy, data, expression)
        : jsonToValue(
              context,
              recipeFactPolicy,
              data,
              expression,
              (leaf, path) =>
                  leaf instanceof UnreadableLeaf
                      ? unreadableValue(leaf.refusal)
                      : leaf instanceof RuntimeLeaf
                        ? creationLaneLeaf(
                              context,
                              variants,
                              data,
                              leaf,
                              path,
                              readMaterial,
                              expression,
                          )
                        : undefined,
          );
    return slots
        ? readSlotMap(context, expression, slots, data, value, readMaterial())
        : value;
}

/**
 * `createMaterialView(source, { features: 0 })` over a ShaderMaterial: a
 * view drawing the source's program over its slots until a statement
 * redefines it (`compileShaderMaterialViewDefinitions`), over each variant
 * the source may be (`runtimeShaderVariants` where the run time decides).
 */
export function compileCreateMaterialView(
    context: Pick<
        ShaderMaterialViewContext,
        | "bindings"
        | "checker"
        | "compileValue"
        | "expectArgumentCount"
        | "fail"
        | "reachFeature"
        | "requireEngine"
        | "staticLiteralData"
        | "symbols"
        | "unwrap"
    > &
        Pick<
            LoweringServices,
            "expectKind" | "reachShaderCreations" | "sceneManifest"
        >,
    call: ts.CallExpression,
): Value {
    context.expectArgumentCount(call, 2, 2);
    const sourceExpression = call.arguments[0]!;
    if (
        !isShaderMaterialType(
            context.checker.getTypeAtLocation(sourceExpression),
        )
    )
        context.fail(
            sourceExpression,
            "createMaterialView views a ShaderMaterial; other material families take their own view helpers (createStandardNoColorMaterialView, createPbrNoColorMaterialView).",
        );
    const source = context.compileValue(sourceExpression);
    context.expectKind(source, "material", sourceExpression);
    if (source.shaderMaterialView)
        context.fail(
            sourceExpression,
            "createMaterialView of a material view views that view's source, without its redefinitions; pass the source material.",
        );
    const features = context.compileValue(call.arguments[1]!);
    const renderFeatures = context.staticLiteralData(
        features,
        call.arguments[1]!,
    );
    if (
        typeof renderFeatures !== "object" ||
        renderFeatures === null ||
        Reflect.get(renderFeatures, "features") !== 0 ||
        ![undefined, 0].includes(
            Reflect.get(renderFeatures, "features2") as number | undefined,
        )
    )
        context.fail(
            call.arguments[1]!,
            "A ShaderMaterial view takes the render features `{ features: 0 }`: a shader program composes no feature flags.",
        );
    const engine = context.requireEngine(source, call);
    context.reachFeature("material:shader", call);
    context.reachFeature("material:shader-view", call);
    // A source of run-time variant may be any the program creates.
    const known = shaderVariantsOf(source);
    const variants = known ?? runtimeShaderVariants(context);
    const binding = optionsBinding(context, sourceExpression);
    const declaration = binding?.symbol.valueDeclaration;
    const sourceName =
        declaration &&
        (ts.isParameter(declaration) ||
            ts.isVariableDeclaration(declaration)) &&
        ts.isIdentifier(declaration.name)
            ? declaration.name
            : undefined;
    const programs = new Map(variants.map((variant) => [variant, variant]));
    return {
        kind: "material",
        cpp: `bbl::create_shader_material_view(${engine}, ${source.cpp})`,
        engineCpp: engine,
        ...shaderVariantFacts(variants),
        shaderMaterialView: {
            source,
            ...(sourceName ? { sourceName } : {}),
            programs,
            declared: programs,
            defined: new Map(),
            ...(known ? {} : { runtimeSource: true as const }),
        },
    };
}

/**
 * The variants a ShaderMaterial generation knows only at run time may be:
 * every variant the program's `createShaderMaterial` calls create, those a
 * previous compile attempt reached after this point included
 * (`ShaderCreationsRequired`). The split records them.
 */
export function runtimeShaderVariants(
    context: Pick<LoweringServices, "reachShaderCreations" | "sceneManifest">,
): readonly string[] {
    context.reachShaderCreations();
    const variants = context.sceneManifest.shaderDerivations.createdVariants();
    context.sceneManifest.shaderDerivations.recordSplit(variants);
    return variants;
}

/**
 * The view an `Object.defineProperty` / `Object.defineProperties` call
 * redefines, when its target is a ShaderMaterial; a ShaderMaterial that is
 * not a view refuses. Undefined for any other target.
 */
export function shaderMaterialViewTarget(
    context: Pick<
        ShaderMaterialViewContext,
        "bindings" | "checker" | "fail" | "unwrap"
    >,
    call: ts.CallExpression,
): ts.Identifier | undefined {
    const target = call.arguments[0];
    if (!target) return undefined;
    const name = context.unwrap(target);
    if (
        ts.isIdentifier(name) &&
        context.bindings.lookupOptional(name)?.shaderMaterialView
    )
        return name;
    if (!isShaderMaterialType(context.checker.getTypeAtLocation(target)))
        return undefined;
    return context.fail(
        target,
        "Object.defineProperty redefines a ShaderMaterial's properties only on a material view a `const` names (createMaterialView); the material itself keeps the program it was created with.",
    );
}

/** One redefined program property: its key and the expression of its value. */
interface ViewRedefinition {
    readonly key: string;
    readonly value: ts.Expression;
    readonly descriptor: ts.ObjectLiteralExpression;
}

/**
 * Each definition as a redefinition of a property the view's program is
 * built from, or of a slot map (`SLOT_MAPS`).
 */
function viewRedefinitions(
    context: Pick<ShaderMaterialViewContext, "checker" | "fail">,
    definitions: readonly ViewDefinition[],
): ViewRedefinition[] {
    return definitions.flatMap(({ key, site, node, descriptor, value }) => {
        const reset = NATIVE_VIEW_CACHE_RESETS.get(key);
        if (reset) {
            const expression = value && unwrapExpression(value);
            const valid =
                expression &&
                (reset === "undefined"
                    ? isGlobalUndefined(context.checker, expression)
                    : reset === "null"
                      ? expression.kind === ts.SyntaxKind.NullKeyword
                      : ts.isPrefixUnaryExpression(expression) &&
                        expression.operator === ts.SyntaxKind.MinusToken &&
                        ts.isNumericLiteral(expression.operand) &&
                        expression.operand.text === "1");
            if (!valid)
                context.fail(
                    node,
                    `A ShaderMaterial view's '${key}' cache reset requires the literal ${reset}.`,
                );
            return [];
        }
        if (!viewFields().includes(key) && !Object.hasOwn(SLOT_MAPS, key))
            context.fail(
                site,
                `A ShaderMaterial view redefines only the properties its program is built from (${viewFields().join(", ")}) and its slot maps (${Object.keys(SLOT_MAPS).join(", ")}); '${key}' is not one.`,
            );
        if (!value)
            context.fail(
                node,
                `A ShaderMaterial view's '${key}' is redefined by a literal data descriptor: a 'value' and literal 'enumerable', 'configurable' or 'writable' flags.`,
            );
        return [{ key, value, descriptor }];
    });
}

// Dawn keys bindings by material_handle; SDL_GPU's shader_draw_textures
// selects the handle's own cache. These pre-use resets therefore emit nothing.
const NATIVE_VIEW_CACHE_RESETS: ReadonlyMap<
    string,
    "undefined" | "null" | "-1"
> = new Map([
    ["_shaderDevice", "undefined"],
    ["_shaderBindings", "undefined"],
    ["_shaderCustomUbo", "null"],
    ["_shaderCustomSpec", "null"],
    ["_shaderCustomData", "null"],
    ["_shaderCustomVersion", "-1"],
]);

/**
 * The native version counters already follow source changes and local
 * assignments. Admit an additive revision descriptor only when its complete
 * factory proves that contract: a private zero-initialized offset, a getter
 * `sourceRevision + offset`, and a setter `offset = value - sourceRevision`.
 * Merely mentioning a version field in an arbitrary getter proves nothing.
 */
export function nativeShaderViewRevision(
    context: ShaderMaterialViewContext & Pick<LoweringServices, "program">,
    target: ts.Identifier,
    key: string,
    expression: ts.Expression,
    readDescriptor: (expression: ts.Expression) => {
        get:
            | ts.MethodDeclaration
            | ts.FunctionExpression
            | ts.ArrowFunction
            | undefined;
        set:
            | ts.MethodDeclaration
            | ts.FunctionExpression
            | ts.ArrowFunction
            | undefined;
        attributes: ReadonlyMap<string, boolean>;
        data: boolean;
    },
): boolean {
    if (!["_uniformVersion", "_resourceVersion", "_uboVersion"].includes(key))
        return false;
    const refuse = (): never =>
        context.fail(
            expression,
            `A ShaderMaterial view's '${key}' needs a source-following additive revision descriptor with a private local offset; other accessors are not native revision counters.`,
        );
    const call = context.unwrap(expression);
    if (!ts.isCallExpression(call)) return refuse();
    const name = context.unwrap(call.expression);
    if (!ts.isIdentifier(name)) return refuse();
    const symbol = context.symbols.valueSymbol(name);
    const declaration = symbol?.valueDeclaration;
    const fn = declaration && functionOfDeclaration(declaration);
    if (
        !symbol ||
        !fn?.body ||
        !ts.isBlock(fn.body) ||
        isAsyncFunction(fn) ||
        fn.asteriskToken ||
        bindingRebinds(
            context.checker,
            context.program.getSourceFiles(),
            symbol,
        ).length ||
        fn.body.statements.length !== 2 ||
        fn.parameters.length < 1 ||
        fn.parameters.length > 2 ||
        call.arguments.length < 1 ||
        call.arguments.length > fn.parameters.length
    )
        return refuse();
    const facts = context.bindings.lookupOptional(target)!.shaderMaterialView!;
    const sameSource = (
        expression: ts.Expression,
        seen = new Set<ts.Symbol>(),
    ): boolean => {
        const receiver = context.unwrap(expression);
        if (!ts.isIdentifier(receiver) || !optionsBinding(context, receiver))
            return false;
        const symbol = context.symbols.valueSymbol(receiver)!;
        if (
            facts.sourceName &&
            symbol === context.symbols.valueSymbol(facts.sourceName)
        )
            return true;
        if (context.bindings.lookupOptional(receiver)?.cpp === facts.source.cpp)
            return true;
        if (seen.has(symbol)) return false;
        seen.add(symbol);
        const declaration = symbol.valueDeclaration;
        return (
            !!declaration &&
            ts.isVariableDeclaration(declaration) &&
            !!declaration.initializer &&
            sameSource(declaration.initializer, seen)
        );
    };
    const callbackField = (expression: ts.Expression): string | undefined => {
        const callback = context.unwrap(expression);
        if (
            (!ts.isArrowFunction(callback) &&
                !ts.isFunctionExpression(callback)) ||
            callback.parameters.length ||
            isAsyncFunction(callback) ||
            (ts.isFunctionExpression(callback) && callback.asteriskToken)
        )
            return undefined;
        const body = callback.body;
        const value = ts.isBlock(body)
            ? body.statements.length === 1 &&
              ts.isReturnStatement(body.statements[0]!)
                ? body.statements[0].expression
                : undefined
            : body;
        const read = value && context.unwrap(value);
        return read &&
            ts.isPropertyAccessExpression(read) &&
            sameSource(read.expression)
            ? read.name.text
            : undefined;
    };
    const readers = new Map<ts.Symbol, string>();
    for (const [index, parameter] of fn.parameters.entries()) {
        if (!ts.isIdentifier(parameter.name) || parameter.dotDotDotToken)
            return refuse();
        const argument = call.arguments[index];
        const fallback =
            parameter.initializer && context.unwrap(parameter.initializer);
        const field = argument
            ? callbackField(argument)
            : fallback && ts.isIdentifier(fallback)
              ? readers.get(context.symbols.valueSymbol(fallback)!)
              : undefined;
        if (
            field !== key &&
            !(
                index === 1 &&
                key === "_uboVersion" &&
                field === "_uniformVersion"
            )
        )
            return refuse();
        readers.set(context.symbols.valueSymbol(parameter.name)!, field);
    }
    const [initialize, returned] = fn.body.statements;
    if (
        !initialize ||
        !ts.isVariableStatement(initialize) ||
        initialize.declarationList.declarations.length !== 1 ||
        !returned ||
        !ts.isReturnStatement(returned) ||
        !returned.expression
    )
        return refuse();
    const offset = initialize.declarationList.declarations[0]!;
    if (
        !ts.isIdentifier(offset.name) ||
        variableKind(offset) !== "let" ||
        !offset.initializer ||
        !ts.isNumericLiteral(offset.initializer) ||
        offset.initializer.text !== "0"
    )
        return refuse();
    const offsetSymbol = context.symbols.valueSymbol(offset.name);
    const isOffset = (expression: ts.Expression): boolean => {
        const value = context.unwrap(expression);
        return (
            ts.isIdentifier(value) &&
            context.symbols.valueSymbol(value) === offsetSymbol
        );
    };
    const base = (expression: ts.Expression): string | undefined => {
        const value = context.unwrap(expression);
        if (!ts.isCallExpression(value)) return undefined;
        const callee = context.unwrap(value.expression);
        if (ts.isIdentifier(callee) && value.arguments.length === 0)
            return readers.get(context.symbols.valueSymbol(callee)!);
        if (
            !isLibraryStatic(
                context.checker,
                value.expression,
                "Math",
                "max",
            ) ||
            value.arguments.length !== 2
        )
            return undefined;
        const left = base(value.arguments[0]!);
        const right = base(value.arguments[1]!);
        return left && right ? `max(${left},${right})` : undefined;
    };
    // Object statics owns descriptor syntax and attribute validation.
    const { get, set, attributes, data } = readDescriptor(returned.expression);
    if (
        !get ||
        !set ||
        data ||
        isAsyncFunction(get) ||
        isAsyncFunction(set) ||
        ("asteriskToken" in get && get.asteriskToken) ||
        ("asteriskToken" in set && set.asteriskToken) ||
        [...attributes.values()].some((flag) => !flag)
    )
        return refuse();
    const getBody = get.body && ts.isBlock(get.body) ? get.body : undefined;
    const setBody = set.body && ts.isBlock(set.body) ? set.body : undefined;
    const getStatement = getBody?.statements[0];
    const setStatement = setBody?.statements[0];
    if (
        !get ||
        !set ||
        get.parameters.length ||
        set.parameters.length !== 1 ||
        getBody?.statements.length !== 1 ||
        setBody?.statements.length !== 1 ||
        !getStatement ||
        !ts.isReturnStatement(getStatement) ||
        !getStatement.expression ||
        !setStatement ||
        !ts.isExpressionStatement(setStatement)
    )
        return refuse();
    const sum = context.unwrap(getStatement.expression);
    const assignment = context.unwrap(setStatement.expression);
    const parameter = set.parameters[0]!;
    if (
        !ts.isBinaryExpression(sum) ||
        sum.operatorToken.kind !== ts.SyntaxKind.PlusToken ||
        !isOffset(sum.right) ||
        !ts.isBinaryExpression(assignment) ||
        assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
        !isOffset(assignment.left) ||
        !ts.isIdentifier(parameter.name) ||
        parameter.initializer ||
        parameter.dotDotDotToken
    )
        return refuse();
    const difference = context.unwrap(assignment.right);
    const source = base(sum.left);
    if (
        !source ||
        !source.includes(key) ||
        !ts.isBinaryExpression(difference) ||
        difference.operatorToken.kind !== ts.SyntaxKind.MinusToken ||
        !ts.isIdentifier(difference.left) ||
        context.symbols.valueSymbol(difference.left) !==
            context.symbols.valueSymbol(parameter.name) ||
        base(difference.right) !== source
    )
        return refuse();
    return true;
}

/** Whether a node is the target of an `Object.defineProperty` / `Object.defineProperties` call. */
function definesOn(checker: ts.TypeChecker, node: ts.Node): boolean {
    const call = outermostWrapper(node).parent;
    return (
        ts.isCallExpression(call) &&
        call.arguments[0] === outermostWrapper(node) &&
        (isLibraryStatic(
            checker,
            call.expression,
            "Object",
            "defineProperty",
        ) ||
            isLibraryStatic(
                checker,
                call.expression,
                "Object",
                "defineProperties",
            ))
    );
}

/**
 * The view's declaration and a definition's statement, when the statement
 * runs where the declaration does: after the view's `const` declaration,
 * or in an unreassigned parameter's body, including their blocks and `if`
 * branches, before every other use. Undefined for any other statement.
 */
function definitionReach(
    context: Pick<
        ShaderMaterialViewContext,
        "bindings" | "checker" | "symbols" | "unwrap"
    > &
        Pick<LoweringServices, "program">,
    call: ts.CallExpression,
    view: ts.Identifier,
):
    | {
          readonly after: readonly ts.Statement[];
          readonly statement: ts.ExpressionStatement;
      }
    | undefined {
    const statement = call.parent;
    const symbol = context.symbols.valueSymbol(view);
    const declaration = symbol?.valueDeclaration;
    const declared =
        declaration && ts.isVariableDeclaration(declaration)
            ? declaration.parent.parent
            : undefined;
    const body =
        declaration &&
        ts.isParameter(declaration) &&
        isSupportedFunction(declaration.parent)
            ? declaration.parent.body
            : undefined;
    const after =
        declared && ts.isVariableStatement(declared)
            ? statementsBeside(declared, "after")
            : body && ts.isBlock(body)
              ? body.statements
              : undefined;
    if (
        !ts.isExpressionStatement(statement) ||
        unwrapExpression(statement.expression) !== call ||
        !after ||
        !optionsBinding(context, view)
    )
        return undefined;
    let node: ts.Node = statement;
    while (!after.some((sibling) => sibling === node)) {
        const parent = node.parent;
        if (
            !ts.isBlock(parent) &&
            !(ts.isIfStatement(parent) && parent.expression !== node)
        )
            return undefined;
        node = parent;
    }
    // Until then the view is only redefined, so the programs it may draw
    // are the ones its definitions derived. A reference on another branch
    // of an `if` holding the statement does not run before it.
    const between = bindingReferences(
        context.program,
        context.checker,
        symbol!,
    ).filter(
        (reference) =>
            reference.pos > (declared?.end ?? body!.pos) &&
            reference.end <= statement.pos &&
            !onOtherBranch(reference, statement),
    );
    return between.every(
        (reference) =>
            definitionOnlyReference(context, reference) &&
            ts.findAncestor(reference, ts.isFunctionLike) ===
                ts.findAncestor(declaration, ts.isFunctionLike),
    )
        ? { after, statement }
        : undefined;
}

/**
 * A direct definition or a helper using its parameter only for definitions.
 * This syntactic proof also covers calls on branches generation never enters.
 */
function definitionOnlyReference(
    context: Pick<LoweringServices, "checker" | "program">,
    reference: ts.Expression,
    visiting = new Set<ts.Node>(),
): boolean {
    if (definesOn(context.checker, reference)) return true;
    const argument = outermostWrapper(reference);
    const call = argument.parent;
    if (!ts.isCallExpression(call) || !ts.isExpressionStatement(call.parent))
        return false;
    const index = call.arguments.findIndex((item) => item === argument);
    const target = callTarget(context.checker, call);
    if (
        index < 0 ||
        target.kind !== "bodies" ||
        target.engine ||
        target.bodies.length !== 1
    )
        return false;
    const fn = target.bodies[0]!;
    if (
        !isSupportedFunction(fn) ||
        visiting.has(fn) ||
        isAsyncFunction(fn) ||
        fn.asteriskToken
    )
        return false;
    const parameter = fn.parameters[index];
    if (
        !parameter ||
        !ts.isIdentifier(parameter.name) ||
        parameter.dotDotDotToken
    )
        return false;
    const callee = unwrapExpression(call.expression);
    if (!ts.isIdentifier(callee)) return false;
    const calleeSymbol = context.checker.getSymbolAtLocation(callee);
    if (
        !calleeSymbol ||
        bindingRebinds(
            context.checker,
            context.program.getSourceFiles(),
            calleeSymbol,
        ).length
    )
        return false;
    const symbol = context.checker.getSymbolAtLocation(parameter.name);
    if (!symbol) return false;
    visiting.add(fn);
    const valid = bindingReferences(
        context.program,
        context.checker,
        symbol,
    ).every(
        (read) =>
            ts.findAncestor(read, ts.isFunctionLike) === fn &&
            definitionOnlyReference(context, read, visiting),
    );
    visiting.delete(fn);
    return valid;
}

/** Record one definition (including an inlined helper), joining its enclosing branches. */
function recordViewDefinition(
    context: Pick<
        ShaderMaterialViewContext,
        "bindings" | "checker" | "symbols" | "unwrap" | "fail"
    > &
        Pick<LoweringServices, "program">,
    call: ts.CallExpression,
    target: ts.Identifier,
    derived: ReadonlyMap<string, string>,
): void {
    const view = context.bindings.lookupOptional(target)!;
    const facts = view.shaderMaterialView!;
    const reach = definitionReach(context, call, target);
    if (!reach)
        context.fail(
            call,
            "A ShaderMaterial view helper redefines an unobserved const or unreassigned parameter in its block or if branches.",
        );
    const { after, statement } = reach;
    const recorded: ShaderMaterialView = {
        ...facts,
        defined: new Map([...facts.defined, [statement, derived]]),
    };
    const top = after.find(
        (sibling) =>
            sibling.pos <= statement.pos && statement.end <= sibling.end,
    )!;
    const reachable = programsThrough(
        recorded,
        after.slice(0, after.indexOf(top) + 1),
        facts.declared,
    );
    const updated = withShaderVariants(view, [...reachable.keys()]);
    writable(updated).shaderMaterialView = { ...recorded, programs: reachable };
    context.bindings.rebindCompileTimeValue(target, updated);
}

/**
 * A synchronous inlined helper receives the programs reaching its call, not
 * the union of its caller's other branches. Its completed definitions are
 * rebound only after the parameter scope has been left.
 */
export function shaderViewCall(
    context: Pick<
        ShaderMaterialViewContext,
        "bindings" | "checker" | "symbols" | "unwrap" | "fail"
    > &
        Pick<LoweringServices, "program">,
    call: ts.Node,
    parameters: readonly ts.ParameterDeclaration[],
    values: readonly Value[],
): {
    readonly values: readonly Value[];
    capture(): () => void;
} {
    const entries: Array<{
        target: ts.Identifier;
        parameter: ts.Identifier;
        initial: ShaderMaterialView;
        statements: readonly ts.Statement[];
    }> = [];
    const arguments_ = values.map((value, index) => {
        if (!value.shaderMaterialView || !ts.isCallExpression(call))
            return value;
        const argument = call.arguments[index];
        const parameter = parameters[index]?.name;
        const target = argument && context.unwrap(argument);
        if (
            !target ||
            !ts.isIdentifier(target) ||
            !parameter ||
            !ts.isIdentifier(parameter)
        )
            return value;
        const owner = parameters[index]!.parent;
        const body = isSupportedFunction(owner) ? owner.body : undefined;
        if (!body || !ts.isBlock(body)) return value;
        const facts = value.shaderMaterialView;
        const reach = definitionReach(context, call, target);
        const programs = reach
            ? programsThrough(
                  facts,
                  reach.after,
                  facts.declared,
                  reach.statement,
              )
            : facts.programs;
        const boundSource =
            facts.sourceName &&
            context.bindings.lookupOptional(facts.sourceName);
        const sourceIndex = values.findIndex(
            (argument) =>
                argument.cpp === facts.source.cpp ||
                argument.cpp === boundSource?.cpp,
        );
        const sourceParameter =
            sourceIndex < 0 ? undefined : parameters[sourceIndex]?.name;
        const initial: ShaderMaterialView = {
            ...facts,
            programs,
            declared: programs,
            defined: new Map(),
            ...(sourceParameter && ts.isIdentifier(sourceParameter)
                ? { sourceName: sourceParameter }
                : {}),
        };
        entries.push({
            target,
            parameter,
            initial,
            statements: body.statements,
        });
        const updated = withShaderVariants(value, [...programs.keys()]);
        writable(updated).shaderMaterialView = initial;
        return updated;
    });
    return {
        values: arguments_,
        capture: () => {
            const updates = entries.flatMap(
                ({ target, parameter, initial, statements }) => {
                    const facts =
                        context.bindings.lookupOptional(
                            parameter,
                        )?.shaderMaterialView;
                    if (!facts || facts.defined.size === 0) return [];
                    if (entries.length > 1)
                        context.fail(
                            parameter,
                            "A ShaderMaterial view definition helper takes one view parameter; multiple possibly aliased view parameters are not supported.",
                        );
                    const symbol = context.symbols.valueSymbol(parameter)!;
                    const owner = parameter.parent.parent;
                    if (
                        !isSupportedFunction(owner) ||
                        isAsyncFunction(owner) ||
                        owner.asteriskToken ||
                        someAnalysisNode(
                            owner,
                            (node) =>
                                ts.isReturnStatement(node) &&
                                ts.findAncestor(node, ts.isFunctionLike) ===
                                    owner,
                        )
                    )
                        context.fail(
                            parameter,
                            "A ShaderMaterial view definition helper is synchronous and has no explicit returns.",
                        );
                    if (
                        !optionsBinding(context, parameter) ||
                        !bindingReferences(
                            context.program,
                            context.checker,
                            symbol,
                        ).every((reference) =>
                            definitionOnlyReference(context, reference),
                        )
                    )
                        context.fail(
                            parameter,
                            "A ShaderMaterial view helper's parameter is used only for definitions and is never reassigned or exposed.",
                        );
                    return [
                        {
                            target,
                            programs: programsThrough(
                                facts,
                                statements,
                                initial.declared,
                            ),
                        },
                    ];
                },
            );
            return () => {
                if (!ts.isCallExpression(call)) return;
                for (const { target, programs } of updates)
                    recordViewDefinition(context, call, target, programs);
            };
        },
    };
}

/** Whether two nodes sit on the two branches of one `if` statement. */
function onOtherBranch(node: ts.Node, other: ts.Node): boolean {
    const branch = (
        inside: ts.Node,
        statement: ts.IfStatement,
    ): ts.Node | undefined =>
        ts.findAncestor(
            inside,
            (ancestor) =>
                ancestor === statement.thenStatement ||
                ancestor === statement.elseStatement,
        );
    return (
        ts.findAncestor(node, (ancestor) => {
            if (!ts.isIfStatement(ancestor)) return false;
            const own = branch(node, ancestor);
            const theirs = branch(other, ancestor);
            return own !== undefined && theirs !== undefined && own !== theirs;
        }) !== undefined
    );
}

/**
 * The programs a view may draw once `statements`, which `statement` may
 * be inside, ran up to it (`until`) or through every one: those it was
 * declared with, through each definition (`defined`), the branches of an
 * `if` joined.
 */
function programsThrough(
    view: ShaderMaterialView,
    statements: readonly ts.Statement[],
    programs: ReadonlyMap<string, string>,
    until?: ts.Statement,
): ReadonlyMap<string, string> {
    const ran = (
        node: ts.Statement,
        before: ReadonlyMap<string, string>,
    ): ReadonlyMap<string, string> => {
        const left = view.defined.get(node);
        if (left) return left;
        if (ts.isBlock(node))
            return programsThrough(view, node.statements, before);
        if (!ts.isIfStatement(node)) return before;
        return new Map([
            ...ran(node.thenStatement, before),
            ...(node.elseStatement ? ran(node.elseStatement, before) : before),
        ]);
    };
    const holds = (node: ts.Node | undefined): node is ts.Statement =>
        node !== undefined &&
        until !== undefined &&
        node.pos <= until.pos &&
        until.end <= node.end;
    for (const statement of statements) {
        if (statement === until) return programs;
        // The block or branch `until` runs in (`definitionReach`).
        const inner = ts.isBlock(statement)
            ? statement.statements
            : ts.isIfStatement(statement)
              ? [statement.thenStatement, statement.elseStatement].filter(holds)
              : [];
        if (holds(statement) && inner.length > 0)
            return programsThrough(view, inner, programs, until);
        programs = ran(statement, programs);
    }
    return programs;
}

/**
 * A redefined declaration list: its items as `optionFact` reads them, or,
 * where generation reads no items there, the plain data its value holds,
 * a part it does not read a leaf (`UnreadableLeaf` for an unreadable value,
 * `RuntimeLeaf` for a run-time number).
 */
function redefinedListFact(
    context: Pick<
        ShaderMaterialViewContext,
        | "checker"
        | "compileValue"
        | "evaluationOrder"
        | "probeEmission"
        | "resolveStaticLiteral"
        | "staticListItems"
        | "staticLiteralData"
    > &
        Pick<LoweringServices, "program">,
    expression: ts.Expression,
): RecordFact {
    const fact = optionFact(context, expression, true);
    if (fact !== "runtime") return fact;
    const data = context.probeEmission(
        () =>
            unlessRefused(() =>
                context.staticLiteralData(
                    context.compileValue(expression),
                    expression,
                    (part): unknown => {
                        const refusal = unreadableRefusal(part);
                        if (refusal !== undefined)
                            return new UnreadableLeaf(refusal);
                        return valueDataType(part)?.kind === "number" &&
                            part.staticNumber === undefined
                            ? new RuntimeLeaf(false)
                            : undefined;
                    },
                ),
            ),
        () => false,
    );
    if (data === undefined) return "runtime";
    return holdsRuntimeLeaf(data) ? { partial: data } : { json: data };
}

/**
 * The options a view's program derives from: `facts`, a source variant's,
 * with each redefinition over them, and each option whose pinned default
 * reads a redefined one fixed at what the source resolved. The program
 * reads them as `viewProgramFact` does.
 */
function viewOptions(
    context: Pick<ShaderMaterialViewContext, "fail">,
    facts: RecordFacts,
    redefined: RecordFacts,
    node: ts.Node,
): RecordFacts {
    const options = new Map<string, RecordFact>();
    for (const [key, fact] of facts) {
        if (redefined.has(key)) continue;
        const program = viewProgramFact(key, fact);
        if (runTimeFact(program))
            context.fail(
                node,
                unreadableFactRefusal(program) ??
                    `A ShaderMaterial view's program compiles from its source's options; the source's '${key}' option is decided at run time.`,
            );
        options.set(key, fact);
    }
    for (const [field, { option, reads }] of fieldsReadingOthers()) {
        if (redefined.has(option) || facts.has(option)) continue;
        if (!reads.some((read) => redefined.has(read))) continue;
        const resolved = pinnedShaderMaterialField(facts, field);
        if (typeof resolved === "string")
            context.fail(
                node,
                `A ShaderMaterial view keeps the '${option}' its source resolved, which generation does not hold: ${resolved}.`,
            );
        options.set(option, resolved);
    }
    for (const [key, fact] of redefined) options.set(key, fact);
    return options;
}

/**
 * The resource declarations a view shares with its source: those of each
 * list but the ones its slot maps `installed` give it.
 */
function slotLayout(
    program: CompiledShaderProgram,
    installed: ReadonlySet<SlotMap["list"]>,
): string {
    return JSON.stringify([
        installed.has("uniforms") ? [] : program.uniforms,
        installed.has("samplers") ? [] : program.samplerDeclarations,
        program.externalTextures ?? [],
        installed.has("storage_buffers") ? [] : program.storageBuffers,
    ]);
}

/**
 * A slot map a definition gives a view, compiled where the statement runs:
 * the C++ of the map and the member each entry holds (`SlotMap`).
 */
function slotMapInstall(
    context: ShaderMaterialViewContext,
    slots: SlotMap,
    expression: ts.Expression,
): { readonly slots: SlotMap; readonly cpp: string; readonly held: string } {
    const value = context.compileValue(expression);
    const type = slotEntryType(
        context,
        valueDataType(value) ?? context.dataLowerer.dataTypeAt(expression),
        slots,
        expression,
    );
    const held = type.fields.find((field) => field.sourceName === slots.held);
    if (!held)
        context.fail(
            expression,
            `A slot map a ShaderMaterial view is given holds records whose '${slots.held}' is what each slot binds.`,
        );
    return {
        slots,
        cpp: context.dataLowerer.compileKnownValueForSink(
            value,
            type.map,
            expression,
        ),
        held: held.name,
    };
}

/**
 * `Object.defineProperty(view, key, { value })` or
 * `Object.defineProperties(view, { key: { value }, ... })` on a
 * ShaderMaterial view (`shaderMaterialViewTarget`): the program each of
 * its variants derives, chosen at run time from the view's own, then the
 * slot maps it is given, which become its slots
 * (`install_shader_view_slots`).
 */
export function compileShaderMaterialViewDefinitions(
    context: ShaderMaterialViewContext & Pick<LoweringServices, "program">,
    call: ts.CallExpression,
    target: ts.Identifier,
    defined: readonly ViewDefinition[],
): Value {
    const redefinitions = viewRedefinitions(context, defined);
    const definitions = redefinitions.filter(
        ({ key }) => !Object.hasOwn(SLOT_MAPS, key),
    );
    // The maps are the run time's, read once where the statement runs.
    const installs = redefinitions.flatMap(({ key, value }) =>
        Object.hasOwn(SLOT_MAPS, key)
            ? [slotMapInstall(context, SLOT_MAPS[key]!, value)]
            : [],
    );
    const installed = new Set(installs.map(({ slots }) => slots.list));
    if (definitions.length > 0)
        deriveViewPrograms(context, call, target, definitions, installed);
    else {
        const view = context.bindings.lookupOptional(target)!;
        const reach = definitionReach(context, call, target);
        if (!reach)
            context.fail(
                call,
                "A ShaderMaterial view's slot maps and native cache resets are defined before any other use of the view.",
            );
        recordViewDefinition(
            context,
            call,
            target,
            programsThrough(
                view.shaderMaterialView!,
                reach.after,
                view.shaderMaterialView!.declared,
                reach.statement,
            ),
        );
    }
    const view = context.bindings.lookupOptional(target)!;
    const engine = context.requireEngine(view, call);
    if (installed.has("uniforms"))
        for (const name of view.shaderMaterialView!.programs.keys())
            if (
                context.sceneManifest.reachedShaderPrograms.find(
                    (program) => program.name === name,
                )?.liftedUniforms
            )
                context.fail(
                    call,
                    `A ShaderMaterial view given its own '_uniformValues' draws shader variant '${name}', which lifts source numbers into uniforms the pin's map does not hold.`,
                );
    if (installs.length > 0) {
        context.reachFeature("material:shader-view", call);
        context.reachFeature("material:shader-slot-maps", call);
    }
    for (const { slots, cpp, held } of installs) {
        const entries = context.allocateTemporaryCppName("shader_slot_entries");
        const entry = context.allocateTemporaryCppName("shader_slot_entry");
        context.emit({
            kind: "expression",
            code: `{ std::vector<bbl::ShaderViewSlotEntry> ${entries}; for (const auto& ${entry} : ${cpp}) ${entries}.push_back(bbl::ShaderViewSlotEntry{${entry}.first, ${entry}.second.weak_identity(), ${entry}.second->${held}}); bbl::install_shader_view_slots(${engine}, ${view.cpp}, bbl::ShaderDeclarationList::${slots.list}, ${entries}); }`,
        });
    }
    return { kind: "void", cpp: "" };
}

/**
 * The programs a view's redefinitions derive, one per variant it may draw:
 * its binding's facts updated and `derive_shader_material_view` emitted.
 * The lists slot maps of the same definition give the view (`installed`)
 * may declare other slots than its source.
 */
function deriveViewPrograms(
    context: ShaderMaterialViewContext & Pick<LoweringServices, "program">,
    call: ts.CallExpression,
    target: ts.Identifier,
    definitions: readonly ViewRedefinition[],
    installed: ReadonlySet<SlotMap["list"]>,
): void {
    const view = context.bindings.lookupOptional(target)!;
    const facts = view.shaderMaterialView!;
    const reach = definitionReach(context, call, target);
    if (!reach)
        context.fail(
            call,
            "A ShaderMaterial view's program is redefined by a statement after the view's `const` declaration, in its block or the `if` branches there, before any other use of the view: the programs it may draw are then the ones every later use reads.",
        );
    const { after, statement } = reach;
    // The programs the view may draw where the statement runs.
    const current = programsThrough(facts, after, facts.declared, statement);
    // A source of no variant created yet derives none; a later creation
    // compiles it again (`refuseWithoutCreations`).
    if (current.size === 0)
        context.sceneManifest.shaderDerivations.refuseWithoutCreations(() =>
            context.fail(
                call,
                "A ShaderMaterial view derives its program from its source's shader variant; this source's variant is decided at run time, and the program creates none.",
            ),
        );
    // Generation evaluates the redefinitions, once per source variant, into
    // the programs; the run time evaluates none of them.
    if (
        !definitions.every(({ descriptor }) =>
            effectFreeOptions(context, descriptor),
        )
    )
        context.fail(
            call,
            "A ShaderMaterial view's redefinitions are evaluated at generation, once per source variant, into its programs; these write storage or run code with effects.",
        );
    if (current.size > 1 && !facts.sourceName)
        context.fail(
            call,
            "A ShaderMaterial view over a material of several variants reads its source per variant through a `const` or a parameter nothing reassigns.",
        );
    const source = facts.source;
    const compileRedefinitions = (variant: string): RecordFacts =>
        context.bindings.withBoundParameters(
            facts.sourceName && current.size > 1
                ? [
                      {
                          name: facts.sourceName,
                          value: withShaderVariants(source, [variant]),
                          compileTime: true,
                      },
                  ]
                : [],
            () =>
                new Map(
                    definitions.map(({ key, value }): [string, RecordFact] => {
                        const field = shaderMaterialField(key)!;
                        const fact = viewDefinitionFact(
                            field.option,
                            field.stage
                                ? shaderSourceFact(context, value, field.stage)
                                : field.items
                                  ? redefinedListFact(context, value)
                                  : optionFact(context, value, false),
                            (item) =>
                                `'${spelled(value)}' gives a ShaderMaterial view's '${key}' a '${String(field.copies)}' of '${String(Reflect.get(item, "name"))}' the run time decides; a view's program takes none, so generation keeps none to read.`,
                        );
                        const program = viewProgramFact(field.option, fact);
                        if (runTimeFact(program))
                            context.fail(
                                value,
                                unreadableFactRefusal(program) ??
                                    `A ShaderMaterial view's '${key}' compiles into its program at generation; this value is decided at run time.`,
                            );
                        return [field.option, fact];
                    }),
                ),
        );
    const derived = new Map<string, string>();
    const programs = new Map<number, CompiledShaderMaterialOptions>();
    let transmissive: boolean | undefined;
    for (const [program, sourceVariant] of current) {
        const redefined = compileRedefinitions(sourceVariant);
        const creations =
            context.sceneManifest.shaderDerivations.creationsOf(program);
        if (creations.length === 0)
            context.fail(
                call,
                `A ShaderMaterial view's program compiles from its source's options; the options shader variant '${program}' was created from are not generation's.`,
            );
        const current = context.sceneManifest.reachedShaderPrograms.findIndex(
            (candidate) => candidate.name === program,
        );
        let compiled!: CompiledShaderMaterialOptions;
        for (const creation of creations) {
            const options = viewOptions(context, creation, redefined, call);
            const programFacts: RecordFacts = new Map(
                [...options].map(([key, fact]) => [
                    key,
                    viewProgramFact(key, fact),
                ]),
            );
            compiled = compileVariantProgram(
                context,
                programs,
                current,
                {
                    name: target,
                    value: factsRecord(context, programFacts, call),
                },
                context.memberLiteral(target, [...programFacts.keys()]),
                {
                    node: call,
                    runtime:
                        "A ShaderMaterial view's program compiles from generation-known options; these lift run-time numbers into uniforms.",
                    twice: `A ShaderMaterial view derives two programs from shader variant '${program}': materials of that variant were created from options that read differently.`,
                },
            );
            context.sceneManifest.shaderDerivations.recordCreation(
                compiled.name,
                options,
            );
        }
        if (
            slotLayout(
                context.sceneManifest.reachedShaderPrograms[compiled.id]!,
                installed,
            ) !==
            slotLayout(
                context.sceneManifest.reachedShaderPrograms[current]!,
                installed,
            )
        )
            context.fail(
                call,
                `A ShaderMaterial view keeps its source's slots; its redefinitions (${definitions.map(({ key }) => key).join(", ")}) declare other uniforms, samplers or storage buffers than shader variant '${program}', which slots of the view's own would hold: the same definition gives the view the slot maps holding them.`,
            );
        if (
            transmissive !== undefined &&
            transmissive !== compiled.transmissive
        )
            context.fail(
                call,
                "A ShaderMaterial view derives transmissive and opaque programs from its source's variants; the run time decides which.",
            );
        transmissive = compiled.transmissive;
        derived.set(compiled.name, sourceVariant);
    }
    const engine = context.requireEngine(view, call);
    const ids = new Map([...programs].map(([from, { id }]) => [from, id]));
    const variant =
        ids.size === 1 && !facts.runtimeSource
            ? `${[...ids.values()][0]!}u`
            : context.sceneManifest.shaderDerivations.derivedVariantCpp(
                  undefined,
                  ids,
                  `bbl::shader_material_view_variant(${engine}, ${view.cpp})`,
              );
    context.reachFeature("material:shader-view", call);
    context.emit({
        kind: "expression",
        code: `bbl::derive_shader_material_view(${engine}, ${view.cpp}, ${variant}, ${transmissive ? "true" : "false"});`,
    });
    // Later uses read the programs every path through the statements up to
    // this one's may leave.
    recordViewDefinition(context, call, target, derived);
}
