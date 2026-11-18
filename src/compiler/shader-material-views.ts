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
    viewFields,
    type RecordFact,
    type RecordFacts,
    type ShaderDerivationContext,
} from "./shader-derivations.js";
import type { CompiledShaderMaterialOptions } from "./shader-material.js";
import { shaderUniformValueLayout } from "../shader-material-programs.js";
import { bindingReferences } from "./binding-references.js";
import { isLibraryStatic } from "./symbols.js";
import {
    outermostWrapper,
    statementsBeside,
    unwrapExpression,
    variableKind,
} from "./syntax.js";
import type { CompiledShaderProgram, Value } from "./types.js";
import {
    shaderVariantFacts,
    shaderVariantsOf,
    withShaderVariants,
} from "./values/model.js";

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
        | "compileShaderSource"
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

/** What each slot map holds at run time. */
const SLOT_MAPS: Readonly<Record<string, string>> = {
    _uniformValues: "the uniform values `setShaderUniform` writes",
    _textureSlots: "the textures `setShaderTexture` binds",
    _storageBufferSlots: "the storage buffers `setShaderStorageBuffer` binds",
};

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
 * change after the creation refuses: the material keeps its numbers.
 */
function creationLaneLeaf(
    context: Pick<ShaderMaterialViewContext, "fail" | "sceneManifest">,
    variants: readonly string[],
    data: unknown,
    leaf: RuntimeLeaf,
    path: readonly (string | number)[],
    material: { readonly engine: string; readonly cpp: string },
    node: ts.Node,
): Value {
    const [item, , lane] = path;
    const name: unknown = Array.isArray(data)
        ? Reflect.get(Object(data[Number(item)]), "name")
        : undefined;
    const slots = variants.map((variant) => {
        const program = context.sceneManifest.reachedShaderProgram(
            variant,
            node,
        );
        return typeof name === "string"
            ? shaderUniformValueLayout(program.uniforms).get(name)
            : undefined;
    });
    if (leaf.shared)
        context.fail(
            node,
            `'${spelled(node)}' reads a ShaderMaterial's '${String(path[1])}' of uniform '${String(name)}', the array its creation was given, which the program may change after the creation (${leaf.shared}); the material keeps only that array's numbers at its creation.`,
        );
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
    const read = (index: number): Value => ({
        kind: "number",
        cpp: `bbl::shader_uniform_creation_lane(${material.engine}, ${material.cpp}, ${slot.offset}u, ${index}u)`,
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
 * map: the plain data the material's variant was built with, or a
 * refusal. Undefined for any other read.
 */
export function readShaderMaterialFact(
    context: Pick<
        ShaderMaterialViewContext,
        | "bindings"
        | "checker"
        | "cppString"
        | "fail"
        | "requireEngine"
        | "sceneManifest"
    >,
    owner: Value,
    expression: ts.PropertyAccessExpression,
): Value | undefined {
    const field = expression.name.text;
    if (!shaderMaterialField(field)?.built && !Object.hasOwn(SLOT_MAPS, field))
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
    const variants = shaderVariantsOf(owner);
    if (!variants)
        context.fail(
            expression,
            `'${spelled(expression)}' reads a ShaderMaterial's '${field}', which its shader variant decides; this material's variant is decided at run time.`,
        );
    const data = variantsField(context, variants, field, expression);
    if (!holdsRuntimeLeaf(data))
        return jsonToValue(context, recipeFactPolicy, data, expression);
    // The leaves read the material once, where the field is read.
    const held = context.bindings.pinValueToTemporary(
        owner,
        "shader_material",
        expression.expression,
    );
    const reader = {
        engine: context.requireEngine(held, expression),
        cpp: held.cpp,
    };
    return jsonToValue(
        context,
        recipeFactPolicy,
        data,
        expression,
        (leaf, path) =>
            leaf instanceof RuntimeLeaf
                ? creationLaneLeaf(
                      context,
                      variants,
                      data,
                      leaf,
                      path,
                      reader,
                      expression,
                  )
                : undefined,
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
    const variants = shaderVariantsOf(source) ?? [];
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

/** Each definition as a redefinition of a property the view's program is built from. */
function viewRedefinitions(
    context: Pick<ShaderMaterialViewContext, "fail">,
    definitions: readonly ViewDefinition[],
): ViewRedefinition[] {
    return definitions.map(({ key, site, node, descriptor, value }) => {
        if (Object.hasOwn(SLOT_MAPS, key))
            context.fail(
                site,
                `A ShaderMaterial view keeps its source's slots; redefining '${key}' would give it slots of its own for ${SLOT_MAPS[key]!}, which generation does not represent.`,
            );
        if (!viewFields().includes(key))
            context.fail(
                site,
                `A ShaderMaterial view redefines only the properties its program is built from (${viewFields().join(", ")}); '${key}' is not one.`,
            );
        if (!value)
            context.fail(
                node,
                `A ShaderMaterial view's '${key}' is redefined by a literal data descriptor: a 'value' and literal 'enumerable', 'configurable' or 'writable' flags.`,
            );
        return { key, value, descriptor };
    });
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
 * runs where the declaration does: after the view's `const` declaration in
 * its block, or inside the blocks and `if` branches of a statement there,
 * before every other use of the view. Undefined for any other statement.
 */
function definitionReach(
    context: Pick<ShaderMaterialViewContext, "checker" | "symbols"> &
        Pick<LoweringServices, "program">,
    call: ts.CallExpression,
    view: ts.Identifier,
):
    | {
          readonly declared: ts.VariableStatement;
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
    if (
        !ts.isExpressionStatement(statement) ||
        unwrapExpression(statement.expression) !== call ||
        !declared ||
        !ts.isVariableStatement(declared) ||
        variableKind(declaration!) !== "const"
    )
        return undefined;
    const after = statementsBeside(declared, "after") ?? [];
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
    // are the ones its definitions derived.
    const between = bindingReferences(
        context.program,
        context.checker,
        symbol!,
    ).filter(
        (reference) =>
            reference.pos > declared.end && reference.end <= statement.pos,
    );
    return between.every(
        (reference) =>
            definesOn(context.checker, reference) &&
            ts.findAncestor(reference, ts.isFunctionLike) ===
                ts.findAncestor(declared, ts.isFunctionLike),
    )
        ? { declared, statement }
        : undefined;
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
        if (runTimeFact(fact))
            context.fail(
                node,
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
    context: ShaderMaterialViewContext & Pick<LoweringServices, "program">,
    call: ts.CallExpression,
    target: ts.Identifier,
    defined: readonly ViewDefinition[],
): Value {
    const view = context.bindings.lookupOptional(target)!;
    const facts = view.shaderMaterialView!;
    const reach = definitionReach(context, call, target);
    if (!reach)
        context.fail(
            call,
            "A ShaderMaterial view's program is redefined by a statement after the view's `const` declaration, in its block or the `if` branches there, before any other use of the view: the programs it may draw are then the ones every later use reads.",
        );
    const { declared, statement } = reach;
    const after = statementsBeside(declared, "after")!;
    // The programs the view may draw where the statement runs.
    const current = programsThrough(facts, after, facts.declared, statement);
    const definitions = viewRedefinitions(context, defined);
    if (current.size === 0)
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
                        const fact = field.stage
                            ? shaderSourceFact(context, value, field.stage)
                            : optionFact(context, value, field.items === true);
                        if (runTimeFact(fact))
                            context.fail(
                                value,
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
            compiled = compileVariantProgram(
                context,
                programs,
                current,
                { name: target, value: factsRecord(context, options, call) },
                context.memberLiteral(target, [...options.keys()]),
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
            ) !==
            slotLayout(context.sceneManifest.reachedShaderPrograms[current]!)
        )
            context.fail(
                call,
                `A ShaderMaterial view keeps its source's slots; its redefinitions (${definitions.map(({ key }) => key).join(", ")}) declare other uniforms, samplers or storage buffers than shader variant '${program}', which slots of the view's own would hold.`,
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
        ids.size === 1
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
    writable(updated).shaderMaterialView = {
        ...recorded,
        programs: reachable,
    };
    context.bindings.rebindCompileTimeValue(target, updated);
    return { kind: "void", cpp: "" };
}
