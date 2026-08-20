// Node-material lowering: the graph a scene hands the pin, read statically.
//
// `parseNodeMaterialFromSnippet` either fetches a snippet or takes the graph
// inline. Only the inline form reaches native, because a fetch is a network
// read at page load and generation has no later moment to perform it in --
// the same boundary every other asset crosses, except that a graph is not a
// URL to materialize but a value already present in the source.
//
// The corpus writes that value two ways, and each gets the answer it deserves.
// A module exporting the object outright is read here as data: object, array,
// string, number, boolean and null, and nothing else -- the fold, because a
// literal cannot drift. A module that BUILDS its graph at load, through id
// counters, spread-composed inputs and arrays it pushes into, is code this
// compiler does not lower; that one is executed at generation, the way a drawn
// atlas and a computed pixel buffer are, and only the module and export travel
// from here.
import ts from "typescript";
import {
    executedModuleReference,
    type ExecutedModuleReferenceContext,
} from "./assets.js";
import {
    validateObjectProperties,
    type ObjectValidationContext,
} from "./option-helpers.js";
import type { CompiledNodeMaterial } from "./types.js";

export interface NodeMaterialContext
    extends ObjectValidationContext, ExecutedModuleReferenceContext {
    readonly reachedNodeMaterials: CompiledNodeMaterial[];
    expectObjectLiteral(
        expression: ts.Expression,
    ): ts.ObjectLiteralExpression;
    objectProperty(
        object: ts.ObjectLiteralExpression,
        name: string,
    ): ts.Expression | undefined;
    resolveStaticExpression(
        expression: ts.Expression,
    ): ts.Expression;
    compileStaticString(expression: ts.Expression): string;
}

/**
 * "Not a JSON literal", distinct from every value one can hold.
 *
 * `null` is a value the graphs carry (`tags: null`), so it cannot double as
 * the miss signal — and a signal the caller has to re-test for `object`,
 * `null` and `Array` is a signal that leaks.
 */
const notJson = Symbol("not a JSON literal");

/** One JSON value out of the source, or `notJson`. */
function staticJson(
    context: NodeMaterialContext,
    expression: ts.Expression,
): unknown {
    const node = context.resolveStaticExpression(expression);
    if (ts.isObjectLiteralExpression(node)) {
        const value: Record<string, unknown> = {};
        for (const property of node.properties) {
            if (!ts.isPropertyAssignment(property)) return notJson;
            const name = ts.isIdentifier(property.name) ||
                    ts.isStringLiteral(property.name) ||
                    ts.isNumericLiteral(property.name)
                ? property.name.text
                : undefined;
            if (name === undefined) return notJson;
            const member = staticJson(context, property.initializer);
            if (member === notJson) return notJson;
            value[name] = member;
        }
        return value;
    }
    if (ts.isArrayLiteralExpression(node)) {
        const values: unknown[] = [];
        for (const element of node.elements) {
            if (
                ts.isSpreadElement(element) ||
                ts.isOmittedExpression(element)
            ) {
                return notJson;
            }
            const member = staticJson(context, element);
            if (member === notJson) return notJson;
            values.push(member);
        }
        return values;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        return node.text;
    }
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (
        ts.isPrefixUnaryExpression(node) &&
        node.operator === ts.SyntaxKind.MinusToken &&
        ts.isNumericLiteral(node.operand)
    ) {
        return -Number(node.operand.text);
    }
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    return notJson;
}

/** How a recorded graph is compared, so two reaches of one share an index. */
function nodeMaterialKey(material: CompiledNodeMaterial): string {
    return material.kind === "literal"
        ? `literal:${JSON.stringify(material.graph)}`
        : `module:${material.module}#${material.exportName}`;
}

/**
 * Lower one `parseNodeMaterialFromSnippet` call to the index of the graph it
 * reached. Graphs are recorded in reach order, which is the generated node
 * variant table's index order.
 */
export function compileNodeMaterialOptions(
    context: NodeMaterialContext,
    snippetExpression: ts.Expression,
    optionsExpression: ts.Expression | undefined,
): number {
    const snippetId = context.compileStaticString(snippetExpression);
    if (snippetId !== "") {
        context.fail(
            snippetExpression,
            "A node material snippet id fetches the graph from the snippet " +
                "server at load; pass the graph through 'json' instead.",
        );
    }
    if (!optionsExpression) {
        context.fail(
            snippetExpression,
            "A node material requires its graph through 'json'.",
        );
    }
    const object = context.expectObjectLiteral(optionsExpression);
    validateObjectProperties(
        context,
        object,
        ["json"],
        "Reached node materials take an inline 'json' graph only; textures, " +
            "shadow generators, skinning, instancing and a block loader are " +
            "not lowered.",
    );
    const jsonExpression = context.objectProperty(object, "json");
    if (!jsonExpression) {
        context.fail(
            object,
            "A node material requires its graph through 'json'.",
        );
    }
    const literal = staticJson(context, jsonExpression);
    let material: CompiledNodeMaterial;
    if (literal !== notJson) {
        if (
            typeof literal !== "object" ||
            literal === null ||
            Array.isArray(literal)
        ) {
            context.fail(
                jsonExpression,
                "A node material graph is a JSON object.",
            );
        }
        material = {
            kind: "literal",
            graph: literal as Record<string, unknown>,
        };
    } else {
        const source = executedModuleReference(context, jsonExpression);
        if (!source) {
            context.fail(
                jsonExpression,
                "A node material graph must be a static JSON literal or a " +
                    "module export this compiler can run at generation.",
            );
        }
        material = { kind: "module", ...source };
    }
    // Two calls naming the same document compose one module and one variant,
    // so a repeat reach returns the first index. Linear over the reached
    // list, which no scene grows past a handful — a keyed map would have to
    // live on the compiler rather than here, and module-level state in a
    // compiler outlives the compile.
    const key = nodeMaterialKey(material);
    const existing = context.reachedNodeMaterials.findIndex(
        (candidate) => nodeMaterialKey(candidate) === key,
    );
    if (existing >= 0) return existing;
    context.reachedNodeMaterials.push(material);
    return context.reachedNodeMaterials.length - 1;
}
