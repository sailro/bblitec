/**
 * A pinned call's callee, resolved by its declaration rather than by how the
 * call happens to spell it.
 *
 * A lowerer that replaces a platform call -- a GPU object's creation, a
 * queue write -- with the native record's own bookkeeping has to know which
 * call it is looking at. Matching the callee's source text would take a
 * shadowing local, or a reworded receiver, for the platform; resolving the
 * name through the module's own symbols takes it for exactly the function
 * or import it names.
 */
import ts from "typescript";
import { declaredSymbol } from "../compiler/symbols.js";
import { moduleSymbols } from "../pinned-program.js";
import type { LoweringContext } from "./context.js";

/**
 * The declaration an identifier in a pinned module resolves to. A
 * shorthand property (`{ texture }`) names the value it copies, not the
 * property it declares.
 */
export function pinnedDeclaration(
    file: ts.SourceFile,
    identifier: ts.Identifier,
): ts.Declaration | undefined {
    return declaredSymbol(moduleSymbols(file), identifier)?.declarations?.[0];
}

/** A pinned function, by the module that declares it and its name. */
interface PinnedFunctionRef {
    readonly module: string;
    readonly name: string;
}

/**
 * The pinned function a call's identifier callee resolves to: one the
 * module declares at its top level, or one it imports by name.
 */
export function pinnedCallee(
    context: LoweringContext,
    file: ts.SourceFile,
    call: ts.CallExpression,
): PinnedFunctionRef | undefined {
    const callee = context.unwrapExpression(call.expression);
    if (!ts.isIdentifier(callee)) return undefined;
    const declaration = pinnedDeclaration(file, callee);
    if (
        declaration &&
        ts.isFunctionDeclaration(declaration) &&
        declaration.parent === file
    ) {
        return { module: file.fileName, name: callee.text };
    }
    if (declaration && ts.isImportSpecifier(declaration)) {
        const imported = (declaration.propertyName ?? declaration.name).text;
        const module = context.moduleOfImport(file.fileName, imported);
        return module ? { module, name: imported } : undefined;
    }
    return undefined;
}

/** Whether a call resolves to one named pinned function. */
export function callsPinned(
    context: LoweringContext,
    file: ts.SourceFile,
    call: ts.CallExpression,
    target: PinnedFunctionRef,
): boolean {
    const callee = pinnedCallee(context, file, call);
    return callee?.module === target.module && callee.name === target.name;
}

/**
 * `<engine>._device.queue.<method>(...)`: a WebGPU queue call through a
 * parameter the pin types `EngineContext`, whose `_device` that interface
 * declares a `GPUDevice` -- the device whose `queue` is WebGPU's own
 * `GPUQueue`. Returns the queue method, or undefined for any other call.
 */
export function webGpuQueueMethod(
    context: LoweringContext,
    file: ts.SourceFile,
    call: ts.CallExpression,
): string | undefined {
    const callee = context.unwrapExpression(call.expression);
    const path = context.propertyPath(callee);
    if (
        !ts.isPropertyAccessExpression(callee) ||
        !path ||
        path.length !== 4 ||
        path[1] !== "_device" ||
        path[2] !== "queue"
    ) {
        return undefined;
    }
    let root: ts.Expression = callee;
    while (ts.isPropertyAccessExpression(root)) root = root.expression;
    const parameter = ts.isIdentifier(root)
        ? pinnedDeclaration(file, root)
        : undefined;
    const type =
        parameter && ts.isParameter(parameter) ? parameter.type : undefined;
    if (
        !type ||
        !ts.isTypeReferenceNode(type) ||
        !ts.isIdentifier(type.typeName) ||
        type.typeName.text !== "EngineContext"
    ) {
        return undefined;
    }
    const module = context.moduleOfImport(file.fileName, "EngineContext");
    if (!module) return undefined;
    const { file: engineFile, declaration } = context.interfaceDeclaration(
        module,
        "EngineContext",
    );
    const device = declaration.members.find(
        (member): member is ts.PropertySignature =>
            ts.isPropertySignature(member) &&
            context.propertyName(member.name) === "_device",
    );
    return device?.type?.getText(engineFile) === "GPUDevice"
        ? path[3]
        : undefined;
}
