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
    staticGraphDocument,
    type ExecutedModuleReferenceContext,
} from "./assets.js";
import {
    validateObjectProperties,
    type ObjectValidationContext,
} from "./option-helpers.js";
import type { CompiledNodeMaterial, Value } from "./types.js";

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
    compileValue(expression: ts.Expression): Value;
    expectKind(
        value: Value,
        kind: Value["kind"],
        node: ts.Node,
    ): void;
}

/** One entry of a call's `textures`, under the binding name it is keyed by. */
export interface NodeMaterialTexture {
    /** The pin's own binding name -- `options.textures` is keyed by it. */
    name: string;
    /** The `loadTexture2D` value the scene supplied for that binding. */
    texture: Value;
}

/** What one reached `parseNodeMaterialFromSnippet` call resolved to. */
export interface CompiledNodeMaterialCall {
    /** The graph's index in the composed variant table. */
    index: number;
    /** The textures the call named, in the source's own order. */
    textures: readonly NodeMaterialTexture[];
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
): CompiledNodeMaterialCall {
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
        ["json", "textures"],
        "Reached node materials take an inline 'json' graph and its " +
            "'textures' only; shadow generators, skinning, instancing and a " +
            "block loader are not lowered.",
    );
    const jsonExpression = context.objectProperty(object, "json");
    if (!jsonExpression) {
        context.fail(
            object,
            "A node material requires its graph through 'json'.",
        );
    }
    const textures = compileTextures(
        context,
        context.objectProperty(object, "textures"),
    );
    const textureNames = textures.map((entry) => entry.name);
    const document = staticGraphDocument(
        context,
        jsonExpression,
        "node material",
        // A module that COMPUTES the document would need the pin's own
        // graph loader to run, which is the boundary this family keeps.
        "export-only",
    );
    const material: CompiledNodeMaterial =
        document.kind === "literal"
            ? { kind: "literal", graph: document.graph, textureNames }
            : {
                  kind: "module",
                  module: document.module,
                  exportName: document.exportName,
                  textureNames,
              };
    // Two calls naming the same document compose one module and one variant,
    // so a repeat reach returns the first index. Linear over the reached
    // list, which no scene grows past a handful — a keyed map would have to
    // live on the compiler rather than here, and module-level state in a
    // compiler outlives the compile.
    const key = nodeMaterialKey(material);
    const existing = context.reachedNodeMaterials.findIndex(
        (candidate) => nodeMaterialKey(candidate) === key,
    );
    if (existing >= 0) {
        // The names belong to the graph, so two calls on one graph name the
        // same bindings; only the images may differ, and those ride the
        // material record. A differing set means the two calls do not
        // describe one graph, which the shared variant table cannot express.
        const shared = context.reachedNodeMaterials[existing]!.textureNames;
        if (
            shared.length !== textureNames.length ||
            shared.some((name, index) => name !== textureNames[index])
        ) {
            context.fail(
                object,
                "Two node materials share a graph but name different " +
                    "texture bindings; the composed variant declares one set.",
            );
        }
        return { index: existing, textures };
    }
    context.reachedNodeMaterials.push(material);
    return {
        index: context.reachedNodeMaterials.length - 1,
        textures,
    };
}

/**
 * The `textures` record, read as the pin reads it: a binding name to the
 * texture that binding samples.
 *
 * The pin looks each declared binding up in this record by name
 * (`options.textures?.[tb._name]`), so what the compiler has to carry is the
 * key beside the value; which pair a name lands on is the composition's
 * answer, not this call's. A binding the graph declares and the record omits
 * is the pin's own render-time error, raised at generation here instead --
 * `src/compose-pipeline.ts` holds that check, because only the composed
 * graph knows what it declared.
 */
function compileTextures(
    context: NodeMaterialContext,
    expression: ts.Expression | undefined,
): readonly NodeMaterialTexture[] {
    if (!expression) return [];
    const record = context.expectObjectLiteral(expression);
    const textures: NodeMaterialTexture[] = [];
    for (const property of record.properties) {
        // `{ diffuse }` and `{ AtlasUV: atlas }` are both written by the
        // corpus, so the value expression is the shorthand's own name or the
        // assignment's initializer.
        const value = ts.isShorthandPropertyAssignment(property)
            ? property.name
            : ts.isPropertyAssignment(property)
                ? property.initializer
                : undefined;
        if (!value) {
            context.fail(
                property,
                "A node material's 'textures' record takes named " +
                    "properties only.",
            );
        }
        const name = property.name
            ? context.propertyName(property.name)
            : undefined;
        if (name === undefined) {
            context.fail(
                property,
                "A node material texture binding is named by an identifier " +
                    "or a string.",
            );
        }
        const texture = context.compileValue(value);
        context.expectKind(texture, "texture", value);
        // The reached slice binds a loaded image, exactly as a shader
        // material's samplers do: `createSolidTexture2D` and
        // `createTexture2DFromPixels` are the same value kind and a
        // different native type, so without this they reach the generated
        // tree as a C++ overload error rather than a refusal naming the call.
        if (!texture.textureFile) {
            context.fail(
                value,
                "Reached node-material textures come from loadTexture2D.",
            );
        }
        textures.push({ name, texture });
    }
    return textures;
}
