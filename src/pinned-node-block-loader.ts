import ts from "typescript";
import { LoweringContext, sharedPinnedContext } from "./lowering/context.js";
import type { NodeMaterialBlockEmitter } from "./compiler/types.js";

/** Resolve an exported block descriptor through its pinned lazy import. */
export function pinnedNodeBlockDescriptor(
    name: string,
): NodeMaterialBlockEmitter {
    const context: LoweringContext = sharedPinnedContext();
    const path = "src/material/node/node-blocks.ts";
    const file = context.sourceFile(path);
    const object = context.unwrapExpression(
        context.variableInitializer(file, name),
    );
    if (!ts.isObjectLiteralExpression(object))
        context.contractError(object, "Expected a node block descriptor.");
    const className = context.stringValue(
        context.propertyInitializer(object, "className"),
        file,
    );
    const load = context.unwrapExpression(
        context.propertyInitializer(object, "_load"),
    );
    if (
        !ts.isArrowFunction(load) ||
        load.parameters.length !== 0 ||
        ts.isBlock(load.body)
    )
        context.contractError(load, "Expected a node block lazy import.");
    const { module, exportName } = context.dynamicImportExport(path, load.body);
    if (exportName !== "emitter")
        context.contractError(
            load.body,
            "Expected a node block emitter export.",
        );
    if (!module.startsWith("src/material/node/blocks/"))
        context.contractError(
            load.body,
            "Expected a packaged node block module.",
        );
    return { className, module: module.slice(4).replace(/\.ts$/, ".js") };
}
