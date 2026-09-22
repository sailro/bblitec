import ts from "typescript";
import type { LoweredSource, LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";

/** Preserve source teardown order and finally completion around native device ownership. */
export function lowerEngineDisposal(context: LoweringContext): LoweredSource {
    const modulePath = "src/engine/engine-dispose.ts";
    const symbolName = "disposeEngine";
    const { file, declaration } = context.functionDeclaration(
        modulePath,
        symbolName,
    );
    const body = lowerPinnedBody(file, declaration.body!.statements, {
        bindings: new Map([
            ["engine", { cpp: "engine", type: "opaque" }],
            ["engine._surfaces", { cpp: "engine", type: "opaque" }],
        ]),
        calls: new Map([
            [
                "disposeGpuResourceRetirements",
                () => "pal::dispose_engine_retirements(engine)",
            ],
            ["stopEngine", () => "stop_engine(engine)"],
            [
                "engine._disposeManagedResources",
                () => "pal::dispose_engine_managed_resources(engine)",
            ],
            [
                "engine._disposeStorageBuffers",
                () => "pal::dispose_engine_storage_buffers(engine)",
            ],
            [
                "engine._device.destroy",
                () => "pal::destroy_engine_device(engine)",
            ],
        ]),
        statement(node, _lowerer, indent) {
            if (ts.isForOfStatement(node)) {
                context.assertStatementShapes(
                    file,
                    [node],
                    `for (const surface of surfaces) {
                    surface._renderingContexts.length = 0;
                    surface._ro?.disconnect();
                    surface._context.unconfigure();
                }`,
                    "Engine surface disposal platform boundary",
                );
                return [`${indent}pal::unconfigure_engine_surfaces(engine);`];
            }
            if (
                ts.isExpressionStatement(node) &&
                ts.isBinaryExpression(node.expression) &&
                node.expression.left.getText(file) === "surfaces.length"
            ) {
                context.assertExpressionShape(
                    node.expression,
                    "surfaces.length = 0",
                    "Disposed engine surface list",
                );
                return [];
            }
            return undefined;
        },
    });
    return {
        modulePath,
        symbolName,
        header: "",
        source: `
// ${context.provenance(modulePath, symbolName)}
#include <bblite/pal_engine_dispose.hpp>
namespace bbl {
void dispose_engine(Engine& engine) {
${body}
}
}
`,
    };
}
