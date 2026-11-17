/**
 * A ShaderMaterial's `uniformDecls`, `samplerDecls` and
 * `storageBufferDecls`: the arrays `createShaderMaterial` builds from its
 * `uniforms`, `samplers` and `storageBuffers` options, in declaration
 * order; and its `attributes`, the names its `attributes` option lists.
 * The native material record's shader variant holds the same names, so a
 * walk over one of them runs over those names.
 */
import ts from "typescript";
import { bindingReferences } from "./binding-references.js";
import { isPinnedType } from "./data-types.js";
import {
    emitCollectionSearch,
    searchPredicate,
    type ElementFields,
    type HandleCollectionTarget,
} from "./handle-collections.js";
import type { LoweringServices } from "./lowering-services.js";
import { declaredSymbol, type NamedMember } from "./symbols.js";
import { writeSiteOf } from "./syntax.js";
import { booleanValue, type Value } from "./types.js";

/** Each list, by the native list holding the same names. */
const DECLARATION_LISTS: Readonly<Record<string, string>> = {
    uniformDecls: "bbl::ShaderDeclarationList::uniforms",
    samplerDecls: "bbl::ShaderDeclarationList::samplers",
    storageBufferDecls: "bbl::ShaderDeclarationList::storage_buffers",
    attributes: "bbl::ShaderDeclarationList::attributes",
};

/** The list whose entries are the names themselves, not declaration records. */
const NAME_LIST = "attributes";

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
    | "requireEngine"
    | "reachFeature"
    | "emit"
    | "increaseIndent"
    | "decreaseIndent"
    | "allocateTemporaryCppName"
    | "allocateBlockPrefix"
    | "registerNativeConstBinding"
>;

/** A walk over one declaration list: the native loop and its bound entry. */
export interface ShaderDeclarationWalk {
    readonly target: HandleCollectionTarget;
    readonly entry: ElementFields;
}

/** The list `<material>.<list>` names, when the expression is one. */
function declarationList(
    context: Pick<ShaderDeclarationContext, "unwrap" | "checker">,
    expression: ts.Expression,
): ts.PropertyAccessExpression | undefined {
    const list = context.unwrap(expression);
    return ts.isPropertyAccessExpression(list) &&
        !ts.isOptionalChain(list) &&
        Object.hasOwn(DECLARATION_LISTS, list.name.text) &&
        isPinnedType(context.checker.getTypeAtLocation(list.expression), [
            "ShaderMaterial",
        ])
        ? list
        : undefined;
}

/** The native names of the list `list` reads, in its order. */
function listNames(
    context: ShaderDeclarationContext,
    list: ts.PropertyAccessExpression,
): { readonly cpp: string; readonly engine: string } {
    const material = context.compileValue(list.expression);
    context.expectKind(material, "material", list.expression);
    const engine = context.requireEngine(material, list.expression);
    context.reachFeature("material:shader", list);
    context.reachFeature("material:shader-declaration-lists", list);
    return {
        cpp: `bbl::shader_declaration_names(${engine}, ${material.cpp}, ${DECLARATION_LISTS[list.name.text]!})`,
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
    const list = declarationList(context, expression);
    if (!list) return undefined;
    const names = list.name.text === NAME_LIST;
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
    const { cpp, engine } = listNames(context, list);
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
    const list = declarationList(context, member.expression);
    if (!list) return undefined;
    if (member.name === "includes" && list.name.text === NAME_LIST) {
        context.expectArgumentCount(call, 1, 1);
        // The list is read before its argument, as JavaScript reads them.
        const names = listNames(context, list).cpp;
        const name = context.dataLowerer.compileForSink(call.arguments[0]!, {
            kind: "string",
        });
        context.reachJsData();
        return booleanValue(`bbl::js::array_includes(${names}, ${name})`);
    }
    if (member.name !== "some") return undefined;
    const predicate = searchPredicate(context, call, "some");
    const walk = shaderDeclarationWalk(
        context,
        member.expression,
        predicate.parameters[0]!.name as ts.Identifier,
    )!;
    return booleanValue(
        emitCollectionSearch(context, walk.target, predicate, true, walk.entry)
            .found,
    );
}
