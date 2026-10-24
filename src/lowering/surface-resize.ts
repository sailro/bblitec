import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import type { PinnedBinding } from "./pinned-numeric-lowerer.js";
import { sameSource } from "../compiler/syntax.js";

/**
 * The pin's `resizeSurface` and `setSurfaceSize` over a Window realm canvas:
 * the client box, device pixel ratio and cap select the backing store; the
 * realm surface carries it to the renderer, which rebuilds canvas-sized
 * targets when its next frame starts.
 */
export function lowerSurfaceResize(
    context: LoweringContext,
    name: string,
): { prototype: string; lines: string[] } {
    const module = "src/engine/surface.ts";
    const { file, declaration: resize } = context.functionDeclaration(
        module,
        "resizeSurface",
    );
    const resizeStatements = resize.body!.statements;
    context.assertStatementShapes(
        resize,
        resizeStatements,
        "const canvas = surface.canvas; if (!isDomCanvas(canvas)) { return; } const clientWidth = surface._w ?? canvas.clientWidth; const clientHeight = surface._h ?? canvas.clientHeight; if (!(clientWidth > 0 && clientHeight > 0)) { return; } const scale = Math.min(globalThis.devicePixelRatio || 1, surface.maxDevicePixelRatio); const w = (clientWidth * scale) | 0; const h = (clientHeight * scale) | 0; setSurfaceSize(surface, w, h);",
        "Surface resize",
    );
    const { declaration: size } = context.functionDeclaration(
        module,
        "setSurfaceSize",
    );
    const sizeStatements = size.body!.statements;
    context.assertStatementShapes(
        size,
        sizeStatements,
        "const canvas = surface.canvas; const w = widthPx | 0; const h = heightPx | 0; if (!(w > 0 && h > 0)) { return; } if (w === canvas.width && h === canvas.height) { return; } canvas.width = w; canvas.height = h; surface.scRT._width = w; surface.scRT._height = h; for (const c of surface._renderingContexts) { c._resize?.(); }",
        "Surface backing size",
    );
    const bindings = new Map<string, PinnedBinding>([
        ["surface", { cpp: "engine", type: "opaque" }],
        ["canvas", { cpp: "engine", type: "opaque" }],
        // `enableSurfaceResizeObserver` caches the same client box.
        ["surface._w", { cpp: "0.0", type: "scalar", staticallyAbsent: true }],
        ["surface._h", { cpp: "0.0", type: "scalar", staticallyAbsent: true }],
        [
            "canvas.clientWidth",
            { cpp: "engine.canvas_client_width", type: "scalar" },
        ],
        [
            "canvas.clientHeight",
            { cpp: "engine.canvas_client_height", type: "scalar" },
        ],
        // The realm global's own value, read once (a defined getter runs per
        // read): a Window host provides it, a worker global reads undefined,
        // which the pin's only test (`|| 1`) treats as it treats NaN.
        [
            "globalThis.devicePixelRatio",
            {
                cpp: "bbl::pal::realm_device_pixel_ratio().value_or(std::numeric_limits<double>::quiet_NaN())",
                type: "scalar",
            },
        ],
        [
            "surface.maxDevicePixelRatio",
            {
                cpp: "bbl::surface_max_device_pixel_ratio(engine)",
                type: "scalar",
            },
        ],
        ["widthPx", { cpp: "widthPx", type: "scalar" }],
        ["heightPx", { cpp: "heightPx", type: "scalar" }],
        [
            "canvas.width",
            {
                cpp: "static_cast<double>(engine.offscreen_run->extent().width)",
                type: "scalar",
            },
        ],
        [
            "canvas.height",
            {
                cpp: "static_cast<double>(engine.offscreen_run->extent().height)",
                type: "scalar",
            },
        ],
    ]);
    const calls = new Map<string, (args: readonly string[]) => string>([
        ["isDomCanvas", () => "engine.dom_canvas"],
        [
            "setSurfaceSize",
            (args) => `${name}_size(engine, ${args.slice(1).join(", ")})`,
        ],
    ]);
    const canvasRead = (statement: ts.Statement): boolean =>
        ts.isVariableStatement(statement) &&
        sameSource(statement.declarationList.declarations[0]!.name, "canvas");
    const resizeBody = lowerPinnedBody(
        file,
        resizeStatements.filter((statement) => !canvasRead(statement)),
        { bindings, calls },
    );
    // canvas.width/height and the swapchain target's extent are one realm
    // surface extent; the renderer resizes its contexts' targets from it.
    const extent = sizeStatements.findIndex(
        (statement) =>
            ts.isExpressionStatement(statement) &&
            context.expressionMatchesShape(
                statement.expression,
                "canvas.width = w",
            ),
    );
    const sizeBody = lowerPinnedBody(
        file,
        sizeStatements
            .slice(0, extent)
            .filter((statement) => !canvasRead(statement)),
        { bindings, calls },
    );
    const prototype = `void ${name}(bbl::Engine& engine);`;
    return {
        prototype,
        lines: [
            `// ${context.provenance(module, "resizeSurface, setSurfaceSize")}`,
            `static void ${name}_size(bbl::Engine& engine, double widthPx, double heightPx) {`,
            sizeBody,
            "    bbl::pal::resize_realm_surface(engine, static_cast<std::uint32_t>(w), static_cast<std::uint32_t>(h));",
            "}",
            "",
            `void ${name}(bbl::Engine& engine) {`,
            "    if (!engine.offscreen_run) return;",
            resizeBody,
            "}",
        ],
    };
}
