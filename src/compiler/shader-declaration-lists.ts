/**
 * A ShaderMaterial's `uniformDecls`, `samplerDecls` and
 * `storageBufferDecls`: the arrays `createShaderMaterial` builds from its
 * `uniforms`, `samplers` and `storageBuffers` options, in declaration
 * order; and its `attributes`, the names its `attributes` option lists.
 * The native material record's shader variant holds the same names, so a
 * walk over one of them runs over those names.
 * Where generation holds the list of each variant the material may be
 * (`holdsShaderMaterialField`), a walk or search reads that plain data
 * instead, and folds where it can.
 */
import ts from "typescript";
import { bindingReferences } from "./binding-references.js";
import {
    emitCollectionSearch,
    searchPredicate,
    type ElementFields,
    type HandleCollectionTarget,
} from "./handle-collections.js";
import type { LoweringServices } from "./lowering-services.js";
import {
    isShaderMaterialType,
    nativeListSearch,
    shaderMaterialField,
} from "./shader-derivations.js";
import { holdsShaderMaterialField } from "./shader-material-views.js";
import { declaredSymbol, type NamedMember } from "./symbols.js";
import { writeSiteOf } from "./syntax.js";
import { booleanValue, type Value } from "./types.js";

type ShaderDeclarationContext = Pick<
    LoweringServices,
    | "program"
    | "checker"
    | "bindings"
    | "conditions"
    | "unwrap"
    | "fail"
    | "expectArgumentCount"
    | "expectKind"
    | "compileValue"
    | "keptEmission"
    | "requireEngine"
    | "reachFeature"
    | "sceneManifest"
    | "emit"
    | "increaseIndent"
    | "decreaseIndent"
    | "allocateTemporaryCppName"
    | "allocateBlockPrefix"
    | "registerNativeConstBinding"
>;

/** A walk over one declaration list: the native loop and its bound entry. */
interface ShaderDeclarationWalk {
    readonly target: HandleCollectionTarget;
    readonly entry: ElementFields;
}

/** A native declaration list read: the list, and its material compiled. */
interface NativeDeclarationList {
    readonly list: ts.PropertyAccessExpression;
    readonly material: Value;
}

/**
 * The native list `<material>.<list>` names, with its material compiled:
 * undefined for any other expression, and where generation holds the
 * list's plain data (`holdsShaderMaterialField`), which the read then takes.
 */
function declarationList(
    context: ShaderDeclarationContext,
    expression: ts.Expression,
): NativeDeclarationList | undefined {
    const list = context.unwrap(expression);
    if (
        !ts.isPropertyAccessExpression(list) ||
        ts.isOptionalChain(list) ||
        !shaderMaterialField(list.name.text)?.nativeList ||
        !isShaderMaterialType(
            context.checker.getTypeAtLocation(list.expression),
        )
    )
        return undefined;
    let held = false;
    const material = context.keptEmission(
        () => context.compileValue(list.expression),
        (value) => !(held = holdsShaderMaterialField(context, value, list)),
    );
    return held ? undefined : { list, material };
}

/** The native list `list` reads. */
function nativeList(list: ts.PropertyAccessExpression) {
    return shaderMaterialField(list.name.text)!.nativeList!;
}

/** The native names of the list `list` reads, in its order. */
function listNames(
    context: ShaderDeclarationContext,
    list: ts.PropertyAccessExpression,
    material: Value,
): { readonly cpp: string; readonly engine: string } {
    context.expectKind(material, "material", list.expression);
    const engine = context.requireEngine(material, list.expression);
    context.reachFeature("material:shader", list);
    context.reachFeature("material:shader-declaration-lists", list);
    return {
        cpp: `bbl::shader_declaration_names(${engine}, ${material.cpp}, ${nativeList(list).cpp})`,
        engine,
    };
}

/**
 * The walk over the list `expression` names, binding each entry to
 * `entry`; undefined for any other expression. An `attributes` entry is
 * its name. A declaration entry is read through its `name` alone, which is
 * what the native list holds; any other use of it refuses, since it would
 * observe a record the list does not keep.
 */
export function shaderDeclarationWalk(
    context: ShaderDeclarationContext,
    expression: ts.Expression,
    entry: ts.Identifier,
): ShaderDeclarationWalk | undefined {
    const read = declarationList(context, expression);
    return read && declarationWalk(context, read, entry);
}

/** The walk over the native list `list` of `material`, as `shaderDeclarationWalk`. */
function declarationWalk(
    context: ShaderDeclarationContext,
    { list, material }: NativeDeclarationList,
    entry: ts.Identifier,
): ShaderDeclarationWalk {
    const names = nativeList(list).names === true;
    const symbol = declaredSymbol(context.checker, entry);
    for (const site of symbol && !names
        ? bindingReferences(context.program, context.checker, symbol)
        : []) {
        const read = site.parent;
        if (
            !ts.isPropertyAccessExpression(read) ||
            read.expression !== site ||
            read.name.text !== "name" ||
            writeSiteOf(read)
        )
            context.fail(
                site,
                `A ShaderMaterial's ${list.name.text} entry is read only through its name.`,
            );
    }
    const { cpp, engine } = listNames(context, list, material);
    return {
        target: {
            property: list.name.text,
            temporaryLabel: "shader_declaration",
            containerCpp: cpp,
            elementKind: names ? "string" : "record",
            elementCppType: "std::string&",
            engineCpp: engine,
        },
        entry: names
            ? {}
            : (item) => ({
                  recordProperties: {
                      name: {
                          kind: "data",
                          cpp: item,
                          dataType: { kind: "string" },
                      },
                  },
              }),
    };
}

/**
 * `<material>.<list>.some(<arrow>)`: the search over the list's names;
 * `<material>.attributes.includes(<name>)`: whether the list holds it.
 */
export function compileShaderDeclarationSearch(
    context: ShaderDeclarationContext &
        Pick<LoweringServices, "dataLowerer" | "reachJsData">,
    call: ts.CallExpression,
    member: NamedMember,
): Value | undefined {
    const list = context.unwrap(member.expression);
    if (
        !ts.isPropertyAccessExpression(list) ||
        !nativeListSearch(list.name.text, member.name)
    )
        return undefined;
    const read = declarationList(context, member.expression);
    if (!read) return undefined;
    if (member.name === "includes") {
        context.expectArgumentCount(call, 1, 1);
        // The list is read before its argument, as JavaScript reads them.
        const names = listNames(context, read.list, read.material).cpp;
        const name = context.dataLowerer.compileForSink(call.arguments[0]!, {
            kind: "string",
        });
        context.reachJsData();
        return booleanValue(`bbl::js::array_includes(${names}, ${name})`);
    }
    const predicate = searchPredicate(context, call, "some");
    const walk = declarationWalk(
        context,
        read,
        predicate.parameters[0]!.name as ts.Identifier,
    );
    return booleanValue(
        emitCollectionSearch(context, walk.target, predicate, true, walk.entry)
            .found,
    );
}
