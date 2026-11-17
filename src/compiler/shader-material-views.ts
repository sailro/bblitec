// A ShaderMaterial's built fields, read at generation, and the material
// views derived from them.
//
// The pin's `createShaderMaterial` builds `vertexSource`, `fragmentSource`,
// `uniformDecls`, `samplerDecls` and `storageBufferDecls` from its options,
// so a material whose shader variant generation knows reads each as the
// plain data the pin builds from that variant's options. Its slot maps
// (`_uniformValues`, `_textureSlots`, `_storageBufferSlots`) hold the
// values and resources bound at run time, which generation does not.
//
// `createMaterialView(source, { features: 0 })` is an object inheriting the
// source. A program property an `Object.defineProperty` or
// `Object.defineProperties` statement redefines on it makes the view draw
// another program: compiled once per variant the source may have, from
// that variant's options with the redefinitions over them, and selected at
// run time from the view's variant (`derived_shader_variant_<site>`). The
// view keeps the source's slots, so a redefinition keeps the uniforms,
// samplers and storage buffers its source declares.
import ts from "typescript";
import { unlessRefused } from "./compile-error.js";
import { writable } from "./emission-transaction.js";
import { jsonToValue } from "./json-value.js";
import type { LoweringServices } from "./lowering-services.js";
import {
    effectFreeOptions,
    isShaderMaterialType,
    optionFact,
    optionsBinding,
    PINNED_SHADER_FIELDS,
    pinnedShaderMaterialField,
    recipeFactPolicy,
    type RecordFact,
    type RecordFacts,
} from "./shader-derivations.js";
import {
    SHADER_DECLARATION_LISTS,
    type CompiledShaderMaterialOptions,
} from "./shader-material.js";
import { plainDataMembers, unwrapExpression, variableKind } from "./syntax.js";
import type { ShaderStage } from "../shader-ir.js";
import type { CompiledShaderProgram, Value } from "./types.js";
import { undefinedValue } from "./values/model.js";

/** A `createMaterialView` over a ShaderMaterial. */
export interface ShaderMaterialView {
    /** The source material as the view read it. */
    readonly source: Value;
    /** The declaration of the binding naming the source, when nothing rebinds it. */
    readonly sourceName?: ts.Identifier;
    /** Each program the view may draw, by variant name, to the source variant it derives from. */
    readonly programs: ReadonlyMap<string, string>;
}

export type ShaderMaterialViewContext = Pick<
    LoweringServices,
    | "bindings"
    | "captureEmittedLines"
    | "checker"
    | "compileShaderSource"
    | "compileValue"
    | "cppString"
    | "emit"
    | "evaluationOrder"
    | "expectArgumentCount"
    | "fail"
    | "intrinsicOptions"
    | "memberLiteral"
    | "probeEmission"
    | "reachFeature"
    | "requireEngine"
    | "resolveStaticLiteral"
    | "sceneManifest"
    | "staticListItems"
    | "staticLiteralData"
    | "symbols"
    | "unwrap"
>;

/** What each slot map holds at run time. */
const SLOT_MAPS: Readonly<Record<string, string>> = {
    _uniformValues: "the uniform values `setShaderUniform` writes",
    _textureSlots: "the textures `setShaderTexture` binds",
    _storageBufferSlots: "the storage buffers `setShaderStorageBuffer` binds",
};

/**
 * The ShaderMaterial properties a view may redefine, by the
 * `createShaderMaterial` option each is built from.
 */
const VIEW_PROGRAM_OPTIONS: Readonly<Record<string, string>> = {
    vertexSource: "vertexSource",
    fragmentSource: "fragmentSource",
    attributes: "attributes",
    uniformDecls: "uniforms",
    samplerDecls: "samplers",
    storageBufferDecls: "storageBuffers",
    needAlphaBlending: "needAlphaBlending",
    blendMode: "blendMode",
    blend: "blend",
    transmissive: "transmissive",
    needAlphaTesting: "needAlphaTesting",
    backFaceCulling: "backFaceCulling",
    depthWrite: "depthWrite",
    depthCompare: "depthCompare",
    depthOnlyFragment: "depthOnlyFragment",
    depthBias: "depthBias",
    depthBiasSlopeScale: "depthBiasSlopeScale",
};

/** The options holding WGSL text, by the stage `createShaderMaterial` compiles each as. */
const SHADER_SOURCES: Readonly<Record<string, ShaderStage>> = {
    vertexSource: "vertex",
    fragmentSource: "fragment",
};

/** The WGSL a source expression compiles to, read without leaving code behind. */
function sourceFact(
    context: Pick<
        ShaderMaterialViewContext,
        "compileShaderSource" | "probeEmission"
    >,
    expression: ts.Expression,
    stage: ShaderStage,
): RecordFact {
    return context.probeEmission(
        () =>
            unlessRefused((): RecordFact => {
                const compiled = context.compileShaderSource(expression, stage);
                return compiled.dynamicUniforms.length > 0
                    ? "runtime"
                    : { json: compiled.source };
            }) ?? "runtime",
        () => false,
    );
}

/**
 * The options whose pinned defaults read another option: a view keeps the
 * value its source resolved for each, whatever it redefines.
 */
const RESOLVED_OPTIONS: Readonly<Record<string, readonly string[]>> = {
    needAlphaBlending: ["needAlphaBlending", "blend"],
    depthWrite: ["depthWrite", "needAlphaBlending", "blend"],
};

/** The variants a material may be, when generation knows them. */
function materialVariants(value: Value): readonly string[] | undefined {
    if (value.sceneShaderVariant !== undefined)
        return [value.sceneShaderVariant];
    return value.possibleSceneShaderVariants?.length
        ? value.possibleSceneShaderVariants
        : undefined;
}

/** The text a refusal names an expression by. */
function spelled(node: ts.Node): string {
    return node.getSourceFile() ? node.getText() : "the material";
}

/**
 * The one reading of a ShaderMaterial field every variant `variants` names
 * gives, or a refusal naming why generation does not hold it.
 */
function variantsField(
    context: Pick<ShaderMaterialViewContext, "fail" | "sceneManifest">,
    variants: readonly string[],
    field: string,
    node: ts.Node,
): unknown {
    let found: { readonly json: unknown } | undefined;
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
                    `'${spelled(node)}' reads a ShaderMaterial's '${field}', which generation does not hold: ${read}.`,
                );
            if (
                found &&
                JSON.stringify(found.json) !== JSON.stringify(read.json)
            )
                context.fail(
                    node,
                    `'${spelled(node)}' reads a ShaderMaterial's '${field}', which differs between the materials it may be; the run time decides which.`,
                );
            found = read;
        }
    }
    return found!.json;
}

/**
 * `<material>.<field>` for a field the pin's `createShaderMaterial` builds
 * (`PINNED_SHADER_FIELDS`) or a slot map: the plain data the material's
 * variant was built with, or a refusal. Undefined for any other read.
 */
export function readShaderMaterialFact(
    context: Pick<
        ShaderMaterialViewContext,
        "checker" | "cppString" | "fail" | "sceneManifest"
    >,
    owner: Value,
    expression: ts.PropertyAccessExpression,
): Value | undefined {
    const field = expression.name.text;
    if (
        !Object.hasOwn(PINNED_SHADER_FIELDS, field) &&
        !Object.hasOwn(SLOT_MAPS, field)
    )
        return undefined;
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
    if (Object.hasOwn(SLOT_MAPS, field))
        context.fail(
            expression,
            `'${spelled(expression)}' reads a ShaderMaterial's '${field}', which holds ${SLOT_MAPS[field]!} at run time; generation reads the material's declarations ('uniformDecls', 'samplerDecls', 'storageBufferDecls'), not its slots.`,
        );
    const variants = materialVariants(owner);
    if (!variants)
        context.fail(
            expression,
            `'${spelled(expression)}' reads a ShaderMaterial's '${field}', which its shader variant decides; this material's variant is decided at run time.`,
        );
    return jsonToValue(
        context,
        recipeFactPolicy,
        variantsField(context, variants, field, expression),
        expression,
    );
}

/**
 * `createMaterialView(source, { features: 0 })` over a ShaderMaterial: a
 * view drawing the source's program over its slots until a statement
 * redefines it (`compileShaderMaterialViewDefinitions`).
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
        Pick<LoweringServices, "expectKind">,
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
    const variants = materialVariants(source) ?? [];
    const binding = optionsBinding(context, sourceExpression);
    const declaration = binding?.symbol.valueDeclaration;
    const sourceName =
        declaration &&
        (ts.isParameter(declaration) ||
            ts.isVariableDeclaration(declaration)) &&
        ts.isIdentifier(declaration.name)
            ? declaration.name
            : undefined;
    return {
        kind: "material",
        cpp: `bbl::create_shader_material_view(${engine}, ${source.cpp})`,
        engineCpp: engine,
        ...variantFacts(variants),
        shaderMaterialView: {
            source,
            ...(sourceName ? { sourceName } : {}),
            programs: new Map(variants.map((variant) => [variant, variant])),
        },
    };
}

/** The variant facts of a material drawing one of `variants`. */
function variantFacts(
    variants: readonly string[],
): Pick<
    Value,
    "shaderVariant" | "sceneShaderVariant" | "possibleSceneShaderVariants"
> {
    if (variants.length === 1)
        return {
            shaderVariant: variants[0]!,
            sceneShaderVariant: variants[0]!,
        };
    return variants.length > 1
        ? { possibleSceneShaderVariants: [...new Set(variants)].sort() }
        : {};
}

/** `value` drawing one of `variants`, in place of the variants it carried. */
function withVariants(value: Value, variants: readonly string[]): Value {
    const updated: Value = { ...value };
    delete writable(updated).shaderVariant;
    delete writable(updated).sceneShaderVariant;
    delete writable(updated).possibleSceneShaderVariants;
    Object.assign(writable(updated), variantFacts(variants));
    return updated;
}

/** One redefined property: its key and the expression of its value. */
interface ViewDefinition {
    readonly key: string;
    readonly value: ts.Expression;
    readonly descriptor: ts.ObjectLiteralExpression;
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

/** Each property a definition call redefines, with its data descriptor. */
function viewDefinitions(
    context: Pick<
        ShaderMaterialViewContext,
        "fail" | "unwrap" | "compileValue"
    >,
    call: ts.CallExpression,
    operation: "defineProperty" | "defineProperties",
): ViewDefinition[] {
    const entries: { key: string; descriptor: ts.Expression; node: ts.Node }[] =
        [];
    if (operation === "defineProperty") {
        const key = context.compileValue(call.arguments[1]!).staticString;
        if (key === undefined)
            context.fail(
                call.arguments[1]!,
                "Object.defineProperty on a ShaderMaterial view needs a property key known at generation.",
            );
        entries.push({ key, descriptor: call.arguments[2]!, node: call });
    } else {
        const map = context.unwrap(call.arguments[1]!);
        if (!ts.isObjectLiteralExpression(map))
            context.fail(
                map,
                "Object.defineProperties on a ShaderMaterial view needs a literal descriptor map.",
            );
        const members = plainDataMembers(map);
        if (!members || members.some((member) => member.kind !== "property"))
            context.fail(
                map,
                "Object.defineProperties on a ShaderMaterial view needs literal property keys without spreads or methods.",
            );
        for (const member of members)
            if (member.kind === "property")
                entries.push({
                    key: member.key,
                    descriptor: member.value,
                    node: member.node,
                });
    }
    return entries.map(({ key, descriptor, node }) => {
        if (Object.hasOwn(SLOT_MAPS, key))
            context.fail(
                node,
                `A ShaderMaterial view keeps its source's slots; redefining '${key}' would give it slots of its own for ${SLOT_MAPS[key]!}, which generation does not represent.`,
            );
        if (!Object.hasOwn(VIEW_PROGRAM_OPTIONS, key))
            context.fail(
                node,
                `A ShaderMaterial view redefines only the properties its program is built from (${Object.keys(VIEW_PROGRAM_OPTIONS).join(", ")}); '${key}' is not one.`,
            );
        const literal = context.unwrap(descriptor);
        const members = ts.isObjectLiteralExpression(literal)
            ? plainDataMembers(literal)
            : undefined;
        const value =
            members?.every(
                (member) =>
                    member.kind === "property" &&
                    [
                        "value",
                        "enumerable",
                        "configurable",
                        "writable",
                    ].includes(member.key) &&
                    (member.key === "value" ||
                        member.value.kind === ts.SyntaxKind.TrueKeyword ||
                        member.value.kind === ts.SyntaxKind.FalseKeyword),
            ) === true
                ? members.find(
                      (member) =>
                          member.kind === "property" && member.key === "value",
                  )?.value
                : undefined;
        if (!value || !ts.isObjectLiteralExpression(literal))
            context.fail(
                descriptor,
                `A ShaderMaterial view's '${key}' is redefined by a literal data descriptor: a 'value' and literal 'enumerable', 'configurable' or 'writable' flags.`,
            );
        return { key, value, descriptor: literal };
    });
}

/**
 * Whether a definition statement runs exactly where the view's declaration
 * does: a statement after it in the same block.
 */
function followsDeclaration(
    context: Pick<ShaderMaterialViewContext, "symbols">,
    call: ts.CallExpression,
    view: ts.Identifier,
): boolean {
    const statement = call.parent;
    const declaration = context.symbols.valueSymbol(view)?.valueDeclaration;
    const declared =
        declaration && ts.isVariableDeclaration(declaration)
            ? declaration.parent.parent
            : undefined;
    return (
        ts.isExpressionStatement(statement) &&
        unwrapExpression(statement.expression) === call &&
        declared !== undefined &&
        ts.isVariableStatement(declared) &&
        variableKind(declaration!) === "const" &&
        declared.parent === statement.parent &&
        declared.pos < statement.pos
    );
}

/**
 * The options a view's program compiles from: `facts`, a source variant's,
 * with each redefinition over them, and each option whose pinned default
 * reads a redefined one fixed at what the source resolved.
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
        if (fact === "runtime")
            context.fail(
                node,
                `A ShaderMaterial view's program compiles from its source's options; the source's '${key}' option is decided at run time.`,
            );
        options.set(key, fact);
    }
    for (const [key, read] of Object.entries(RESOLVED_OPTIONS)) {
        if (redefined.has(key) || facts.has(key)) continue;
        if (!read.some((option) => redefined.has(option))) continue;
        const resolved = pinnedShaderMaterialField(facts, key, read);
        if (typeof resolved === "string")
            context.fail(
                node,
                `A ShaderMaterial view keeps the '${key}' its source resolved, which generation does not hold: ${resolved}.`,
            );
        options.set(key, resolved);
    }
    for (const [key, fact] of redefined) options.set(key, fact);
    return options;
}

/** Options as the compile-time record a synthesized options literal reads. */
function optionsRecord(
    context: Pick<ShaderMaterialViewContext, "cppString" | "fail">,
    options: RecordFacts,
    node: ts.Node,
): Value {
    return {
        kind: "record",
        cpp: "",
        recordOwnKeys: [...options.keys()],
        recordProperties: Object.fromEntries(
            [...options].map(([key, fact]) => [
                key,
                typeof fact === "object"
                    ? jsonToValue(context, recipeFactPolicy, fact.json, node)
                    : undefinedValue(),
            ]),
        ),
    };
}

/** The resource declarations a view shares with its source. */
function slotLayout(program: CompiledShaderProgram): string {
    return JSON.stringify([
        program.uniforms,
        program.samplerDeclarations,
        program.externalTextures ?? [],
        program.storageBuffers,
    ]);
}

/**
 * `Object.defineProperty(view, key, { value })` or
 * `Object.defineProperties(view, { key: { value }, ... })` on a
 * ShaderMaterial view (`shaderMaterialViewTarget`): the program each of
 * its variants derives, chosen at run time from the view's own.
 */
export function compileShaderMaterialViewDefinitions(
    context: ShaderMaterialViewContext,
    call: ts.CallExpression,
    target: ts.Identifier,
    operation: "defineProperty" | "defineProperties",
): Value {
    const view = context.bindings.lookupOptional(target)!;
    const facts = view.shaderMaterialView!;
    if (!followsDeclaration(context, call, target))
        context.fail(
            call,
            "A ShaderMaterial view's program is redefined by a statement after the view's `const` declaration, in the same block: the program it draws is then the one every later use reads.",
        );
    const definitions = viewDefinitions(context, call, operation);
    if (facts.programs.size === 0)
        context.fail(
            call,
            "A ShaderMaterial view derives its program from its source's shader variant; this source's variant is decided at run time.",
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
    if (facts.programs.size > 1 && !facts.sourceName)
        context.fail(
            call,
            "A ShaderMaterial view over a material of several variants reads its source per variant through a `const` or a parameter nothing reassigns.",
        );
    const source = facts.source;
    const compileRedefinitions = (variant: string): RecordFacts =>
        context.bindings.withBoundParameters(
            facts.sourceName && facts.programs.size > 1
                ? [
                      {
                          name: facts.sourceName,
                          value: withVariants(source, [variant]),
                          compileTime: true,
                      },
                  ]
                : [],
            () =>
                new Map(
                    definitions.map(({ key, value }): [string, RecordFact] => {
                        const option = VIEW_PROGRAM_OPTIONS[key]!;
                        const stage = SHADER_SOURCES[option];
                        const fact = stage
                            ? sourceFact(context, value, stage)
                            : optionFact(
                                  context,
                                  value,
                                  SHADER_DECLARATION_LISTS.has(option),
                              );
                        if (fact === "runtime")
                            context.fail(
                                value,
                                `A ShaderMaterial view's '${key}' compiles into its program at generation; this value is decided at run time.`,
                            );
                        return [option, fact];
                    }),
                ),
        );
    const derived = new Map<string, string>();
    const ids = new Map<number, number>();
    let transmissive: boolean | undefined;
    for (const [program, sourceVariant] of facts.programs) {
        const redefined = compileRedefinitions(sourceVariant);
        const creations =
            context.sceneManifest.shaderDerivations.creationsOf(program);
        if (creations.length === 0)
            context.fail(
                call,
                `A ShaderMaterial view's program compiles from its source's options; the options shader variant '${program}' was created from are not generation's.`,
            );
        const current = context.sceneManifest.reachedShaderPrograms.find(
            (candidate) => candidate.name === program,
        )!;
        let compiled: CompiledShaderMaterialOptions | undefined;
        for (const creation of creations) {
            const options = viewOptions(context, creation, redefined, call);
            let next!: CompiledShaderMaterialOptions;
            context.captureEmittedLines(() => {
                next = context.bindings.withBoundParameters(
                    [
                        {
                            name: target,
                            value: optionsRecord(context, options, call),
                            compileTime: true,
                        },
                    ],
                    () =>
                        context.intrinsicOptions.compileShaderMaterialOptions(
                            context.memberLiteral(target, [...options.keys()]),
                        ),
                );
            });
            if (next.dynamicUniforms)
                context.fail(
                    call,
                    "A ShaderMaterial view's program compiles from generation-known options; these lift run-time numbers into uniforms.",
                );
            if (compiled && compiled.id !== next.id)
                context.fail(
                    call,
                    `A ShaderMaterial view derives two programs from shader variant '${program}': materials of that variant were created from options that read differently.`,
                );
            compiled = next;
            context.sceneManifest.shaderDerivations.recordCreation(
                next.name,
                options,
            );
        }
        const reached =
            context.sceneManifest.reachedShaderPrograms[compiled!.id]!;
        if (slotLayout(reached) !== slotLayout(current))
            context.fail(
                call,
                `A ShaderMaterial view keeps its source's slots; its redefinitions (${definitions.map(({ key }) => key).join(", ")}) declare other uniforms, samplers or storage buffers than shader variant '${program}', which slots of the view's own would hold.`,
            );
        if (
            transmissive !== undefined &&
            transmissive !== compiled!.transmissive
        )
            context.fail(
                call,
                "A ShaderMaterial view derives transmissive and opaque programs from its source's variants; the run time decides which.",
            );
        transmissive = compiled!.transmissive;
        derived.set(compiled!.name, sourceVariant);
        ids.set(
            context.sceneManifest.reachedShaderPrograms.indexOf(current),
            compiled!.id,
        );
    }
    const engine = context.requireEngine(view, call);
    const variant =
        ids.size === 1
            ? `${[...ids.values()][0]!}u`
            : `bblscene::derived_shader_variant_${context.sceneManifest.shaderDerivations.recordSite(undefined, ids)}(bbl::shader_material_view_variant(${engine}, ${view.cpp}))`;
    context.reachFeature("material:shader-view", call);
    context.emit({
        kind: "expression",
        code: `bbl::derive_shader_material_view(${engine}, ${view.cpp}, ${variant}, ${transmissive ? "true" : "false"});`,
    });
    const updated = withVariants(view, [...derived.keys()]);
    writable(updated).shaderMaterialView = { ...facts, programs: derived };
    context.bindings.rebindCompileTimeValue(target, updated);
    return { kind: "void", cpp: "" };
}
