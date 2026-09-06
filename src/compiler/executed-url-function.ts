/**
 * A URL a scene function produces from a canvas it draws, executed at
 * generation by the bake that consumes it.
 *
 * `npe-sprite2d-fixture.ts#createNpeSprite2DFlareUrl` draws a radial
 * gradient into an `OffscreenCanvas`, encodes it to a PNG blob and returns
 * `URL.createObjectURL(blob)`; the scene hands that URL to the graph
 * factory whose texture block loads it. The bytes are a browser
 * rasterizer's, exactly as `browser-texture-function.ts` says of the
 * rasterized face, so the function is not lowered. It is not executed
 * HERE either: the URL is meaningful only in the page that made it, and the
 * one consumer this compiler reaches is a node-particle graph factory whose
 * driver already runs in that page. So the call binds to the function's
 * identity -- its module and export -- and the driver runs it, in the same
 * browser, immediately before the build the scene awaited it for.
 *
 * What qualifies is bounded by the same structure the texture producer is:
 * a zero-parameter function whose same-file call closure owns a canvas and
 * reaches `URL.createObjectURL`, and reaches nothing from the pin. The
 * value it binds can only be handed to a graph factory or released through
 * `URL.revokeObjectURL`; every other use fails at the value.
 */
import ts from "typescript";
import {
    findRepositoryRoot,
    repositoryRelativePath,
} from "../upstream-source.js";
import {
    containsValueNode,
    importsAreExecutable,
    ownsCanvas,
    sameFileClosure,
} from "./browser-texture-function.js";
import type { ResolvedCompileOptions, Value } from "./types.js";
import { tryResolveFunctionDeclaration } from "./user-functions.js";

export interface ExecutedUrlCallContext {
    readonly checker: ts.TypeChecker;
    readonly options: ResolvedCompileOptions;
    /** The producers the browser ran; the adaptation record names them. */
    readonly browserTextureFunctions: Set<string>;
    fail(node: ts.Node, message: string): never;
}

function createsObjectUrl(node: ts.Node): boolean {
    return containsValueNode(
        node,
        (child) =>
            ts.isCallExpression(child) &&
            ts.isPropertyAccessExpression(child.expression) &&
            child.expression.name.text === "createObjectURL" &&
            ts.isIdentifier(child.expression.expression) &&
            child.expression.expression.text === "URL",
    );
}

/**
 * Whether a declaration is a bounded URL producer: zero parameters, a
 * same-file closure that owns a canvas and creates an object URL, and no
 * reach into the pin or into a foreign function.
 */
function isExecutedUrlFunction(
    checker: ts.TypeChecker,
    declaration: ts.FunctionDeclaration,
): boolean {
    if (!declaration.body || declaration.parameters.length !== 0) return false;
    if (!declaration.name || !ts.isSourceFile(declaration.parent)) return false;
    const sourceFile = declaration.parent;
    if (!sourceFile.text.includes("createObjectURL")) return false;
    if (!importsAreExecutable(sourceFile)) return false;
    const closure = sameFileClosure(checker, declaration, () => false);
    return (
        closure !== undefined &&
        closure.some((member) => ownsCanvas(member)) &&
        closure.some((member) => createsObjectUrl(member))
    );
}

/** The verdict per declaration, as the texture producer gate caches its shape. */
const urlProducers = new WeakMap<ts.Node, boolean>();

export function compileExecutedUrlFunctionCall(
    context: ExecutedUrlCallContext,
    call: ts.CallExpression,
    callee: ts.Identifier,
): Value | undefined {
    const declaration = tryResolveFunctionDeclaration(context.checker, callee);
    if (!declaration || !ts.isFunctionDeclaration(declaration)) return undefined;
    let qualifies = urlProducers.get(declaration);
    if (qualifies === undefined) {
        qualifies = isExecutedUrlFunction(context.checker, declaration);
        urlProducers.set(declaration, qualifies);
    }
    if (!qualifies) return undefined;
    const name = declaration.name!.text;
    if (call.arguments.length !== 0) {
        context.fail(call, `'${name}' produces its URL in a browser canvas at generation and takes no arguments.`);
    }
    if ((ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Export) === 0) {
        context.fail(
            call,
            `'${name}' is run by the bake driver in the browser, so it must be exported.`,
        );
    }
    const sourceFile = declaration.getSourceFile();
    const module = repositoryRelativePath(
        findRepositoryRoot(sourceFile.fileName),
        sourceFile.fileName,
    );
    if (module.startsWith("..")) {
        context.fail(call, `'${name}' lives outside the repository.`);
    }
    context.browserTextureFunctions.add(name);
    return {
        kind: "executed-url",
        cpp: "",
        executedUrl: { module, exportName: name },
    };
}
