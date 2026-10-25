import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { sameSyntax } from "../compiler/syntax.js";

const geometryModule = "src/frame-graph/geometry-renderer-task.ts";

/**
 * The pin's geometry-task re-sync, which `pal_gpu_velocity.hpp` restates
 * for the task's Standard velocity history: `rebuildBoundMeshes` runs at
 * every `record()` and whenever the scene's renderable version moves; it
 * carries an entry still drawn through the forward renderable it was built
 * alongside, and nothing once the `_cfg` stamp changed, which `executeTask`
 * clears under a floating origin when a frame draws with another camera.
 * A native geometry task's factory admits no camera override and no culling
 * flip, so its stamp is the device and the scene's camera.
 */
export function assertGeometryTaskSync(context: LoweringContext): void {
    const record = context.functionDeclaration(geometryModule, "recordTask");
    context.assertStatementShapes(
        record.declaration,
        record.declaration.body!.statements.slice(-2),
        "rebuildBoundMeshes(task, config, eng, sc); rebuildRenderPassDescriptor(task, config);",
        "Geometry task record sync",
    );

    const rebuild = context.functionDeclaration(
        geometryModule,
        "rebuildBoundMeshes",
    ).declaration;
    for (const [name, shape] of [
        [
            "cfg",
            "[task._device, config.camera ?? null, config.camera ?? sc.camera, config.reverseCulling]",
        ],
        ["fresh", "cfg.some((value, index) => value !== task._cfg[index])"],
        ["previous", "new Map(fresh ? [] : oldBound.map((b) => [b._mesh, b]))"],
    ] as const) {
        if (
            !context.expressionMatchesShape(
                context.variableInitializer(rebuild, name),
                shape,
            )
        )
            context.contractError(
                rebuild,
                `Expected the geometry sync's '${name}' to be ${shape}.`,
            );
    }
    // One `if` or expression statement, found by its head, asserted whole.
    const statementWith = (
        owner: ts.FunctionDeclaration,
        source: string,
        label: string,
    ): void => {
        const expected = ts.createSourceFile(
            "expected-statement.ts",
            source,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
        ).statements[0]!;
        if (!ts.isIfStatement(expected) && !ts.isExpressionStatement(expected))
            throw new Error(`Unsupported geometry sync statement: ${source}`);
        const found = context.findNodes(
            owner,
            (node): node is ts.IfStatement | ts.ExpressionStatement =>
                node.kind === expected.kind &&
                sameSyntax(
                    (node as ts.IfStatement | ts.ExpressionStatement)
                        .expression,
                    expected.expression,
                ),
        );
        if (found.length !== 1)
            return context.contractError(owner, `Expected the ${label}.`);
        context.assertStatementShapes(owner, found, source, label);
    };
    statementWith(
        rebuild,
        `if (fwd && prev?._fwd === fwd && prev._view.source === resolved._mat) {
            previous.delete(mesh);
            nextBound.push(prev);
            continue;
        }`,
        "geometry sync's carry of an entry drawn through its forward renderable",
    );
    statementWith(rebuild, "task._cfg = cfg;", "geometry sync's stamp");
    statementWith(
        rebuild,
        "task._boundVer = sc._renderableVersion;",
        "geometry sync's scene version",
    );

    const execute = context.functionDeclaration(
        geometryModule,
        "executeTask",
    ).declaration;
    statementWith(
        execute,
        `if (sc._renderableVersion !== task._boundVer) {
            rebuildBoundMeshes(task, config, eng, sc);
        }`,
        "geometry task's version sync",
    );
    statementWith(
        execute,
        `if (eng.useFloatingOrigin && camera !== task._cfg[2]) {
            task._cfg.length = 0;
        }`,
        "geometry task's floating-origin stamp clear",
    );
}
