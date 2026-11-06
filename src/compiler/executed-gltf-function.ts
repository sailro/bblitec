/**
 * A function that builds a glTF document in code and loads it, run at
 * generation.
 *
 * The pin's `loadGltf(engine, blob)` parses a Blob's bytes as it parses a
 * fetched file's, with no base URL (`load-gltf.ts`). A function whose return
 * is that load over a Blob it builds from closed data -- typed arrays,
 * `JSON.stringify`, `btoa` -- builds the same bytes on every run, so
 * generation runs it (`executeApplicationFunction`, with `loadGltf` standing
 * in as a recorder of the Blob it is handed) and the call is the load of
 * that document, packaged. The function's body never reaches the native
 * program.
 *
 * Shape: a module-scope function declaration whose last statement returns
 * `loadGltf(engine, new Blob(...))`, `engine` a parameter read nowhere else.
 * A function of another shape is an ordinary call, and the inliner owns it;
 * one of this shape that cannot run at generation refuses.
 */
import ts from "typescript";
import { GLB_MAGIC } from "../gltf-document.js";
import { forEachAnalysisNode } from "./analysis-walk.js";
import { EmissionWeakMap } from "./emission-transaction.js";
import { generationBlobBytes } from "./generation-blob.js";
import {
    compileGeneratedGltfLoad,
    type AssetIntrinsicContext,
} from "./intrinsics/asset.js";
import type { LoweringServices } from "./lowering-services.js";
import { declaredSymbol, libraryGlobal } from "./symbols.js";
import { isValueReference, unwrapExpression } from "./syntax.js";
import { finalReturn } from "./loop-control.js";
import type { Value } from "./types.js";
import { tryResolveFunctionDeclaration } from "./user-functions.js";

interface ExecutedGltfShape {
    declaration: ts.FunctionDeclaration;
    name: string;
    /** The parameter the load names as its engine. */
    engine: number;
}

type ExecutedGltfCallContext = AssetIntrinsicContext &
    Pick<LoweringServices, "runGenerationFunction">;

const shapes = new EmissionWeakMap<ts.Node, ExecutedGltfShape | null>();

function unwrapped(expression: ts.Expression): ts.Expression {
    return unwrapExpression(expression, { await: true });
}

/** The returned `loadGltf(p, new Blob(...))` of a module-scope function, or undefined. */
function producerShape(
    context: ExecutedGltfCallContext,
    declaration: ts.Node,
): ExecutedGltfShape | undefined {
    if (
        !ts.isFunctionDeclaration(declaration) ||
        !declaration.body ||
        !declaration.name ||
        !ts.isSourceFile(declaration.parent)
    ) {
        return undefined;
    }
    const returned = finalReturn(declaration.body)?.expression;
    if (!returned) return undefined;
    const load = unwrapped(returned);
    if (
        !ts.isCallExpression(load) ||
        !ts.isIdentifier(load.expression) ||
        context.symbols.babylonImportName(load.expression) !== "loadGltf"
    ) {
        return undefined;
    }
    const source = load.arguments[1] && unwrapped(load.arguments[1]);
    if (
        !source ||
        !ts.isNewExpression(source) ||
        libraryGlobal(context.checker, source.expression) !== "Blob"
    ) {
        return undefined;
    }
    const name = declaration.name.text;
    if (load.arguments.length !== 2) {
        context.fail(
            load,
            `'${name}' builds its glTF at generation; its loadGltf takes the engine and the Blob alone.`,
        );
    }
    const engineArgument = unwrapped(load.arguments[0]!);
    const engineSymbol = ts.isIdentifier(engineArgument)
        ? declaredSymbol(context.checker, engineArgument)
        : undefined;
    const engine = declaration.parameters.findIndex(
        (parameter) =>
            ts.isIdentifier(parameter.name) &&
            engineSymbol !== undefined &&
            declaredSymbol(context.checker, parameter.name) === engineSymbol,
    );
    if (engine < 0 || declaration.parameters.length !== 1) {
        context.fail(
            declaration,
            `'${name}' builds its glTF at generation, so its one parameter is the engine its loadGltf takes.`,
        );
    }
    forEachAnalysisNode(
        declaration.body,
        (node) => {
            if (
                !ts.isIdentifier(node) ||
                !isValueReference(node) ||
                node === engineArgument
            )
                return;
            const symbol = declaredSymbol(context.checker, node);
            if (symbol === engineSymbol) {
                context.fail(
                    node,
                    `'${name}' builds its glTF at generation, where its engine exists only as loadGltf's argument.`,
                );
            }
            if (
                node !== load.expression &&
                context.symbols.babylonImportName(node) !== undefined
            ) {
                context.fail(
                    node,
                    `'${name}' builds its glTF at generation, which runs no pinned API but its one loadGltf.`,
                );
            }
        },
        { types: "skip" },
    );
    return { declaration, name, engine };
}

/**
 * Lower a call of a glTF producer as the load of the document it builds.
 * Undefined when the callee is no producer, so ordinary inlining owns it.
 */
export function compileExecutedGltfFunctionCall(
    context: ExecutedGltfCallContext,
    call: ts.CallExpression,
    callee: ts.Identifier,
): Value | undefined {
    const declaration = tryResolveFunctionDeclaration(context.checker, callee);
    if (!declaration) return undefined;
    let shape = shapes.get(declaration);
    if (shape === undefined) {
        shape = producerShape(context, declaration) ?? null;
        shapes.set(declaration, shape);
    }
    if (!shape) return undefined;
    const engineArgument = call.arguments[shape.engine];
    if (!engineArgument || call.arguments.length !== 1) {
        context.fail(
            call,
            `'${shape.name}' takes the engine its glTF loads into, alone.`,
        );
    }
    const engine = context.compileValue(engineArgument);
    context.expectKind(engine, "engine", engineArgument);
    const label = `glTF producer '${shape.name}'`;
    const document = context.runGenerationFunction(
        shape.declaration,
        [null],
        label,
        (name) =>
            name === "loadGltf"
                ? (_engine: unknown, source: unknown): string => {
                      const blob = generationBlobBytes(source);
                      if (!blob) {
                          throw new Error(
                              "its loadGltf was handed something other than a Blob.",
                          );
                      }
                      // The pin tells GLB from JSON by the magic, not the type.
                      const glb =
                          blob.bytes.length >= 4 &&
                          blob.bytes.readUInt32LE(0) === GLB_MAGIC;
                      return `data:${glb ? "model/gltf-binary" : "model/gltf+json"};base64,${blob.bytes.toString("base64")}`;
                  }
                : undefined,
    );
    if (typeof document !== "string") {
        context.fail(call, `${label} returned no loaded document.`);
    }
    return compileGeneratedGltfLoad(context, call, engine, document);
}
