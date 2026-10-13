import type { LoweringContext } from "./context.js";
import { recordAt } from "../compiler/record-access.js";

const rttModule = "src/texture/rtt.ts";
const targetModule = "src/engine/render-target.ts";

/**
 * `disposeRenderTargetTexture`: `disposeRenderTarget` over a target the RTT
 * factory made eager with an attachment hook, so the hook releases the
 * attachments. A backend owns a target's GPU allocation, so the native
 * release retires the record and moves the target version; the backend's
 * next target build releases the allocation behind its in-flight frames.
 * With the surface protocol (`surface`), the hook is the lifecycle's: it
 * marks the target disposed for later observers and retires replacements
 * still awaiting delivery.
 */
export function lowerRenderTargetDisposal(
    context: LoweringContext,
    surface: boolean,
): string {
    const dispose = context.functionDeclaration(
        rttModule,
        "disposeRenderTargetTexture",
    ).declaration;
    context.assertStatementShapes(
        dispose.body!,
        dispose.body!.statements,
        "disposeRenderTarget(result.rt);",
        "Render-target texture disposal",
    );
    const target = context.functionDeclaration(
        targetModule,
        "disposeRenderTarget",
    ).declaration;
    context.assertStatementShapes(
        target.body!,
        target.body!.statements,
        `
        if (!rt || (rt._eager && !rt._disposeAttachments)) {
            return;
        }
        const color = rt._colorTexture;
        const depth = rt._depthTexture;
        rt._colorTexture = rt._depthTexture = null;
        rt._colorView = rt._depthView = null;
        rt._width = rt._height = 0;
        if (rt._disposeAttachments) {
            rt._disposeAttachments(color, depth);
        } else {
            try {
                color?.destroy();
            } finally {
                if (rt._ownsDepthTexture !== false) {
                    depth?.destroy();
                }
            }
        }
    `,
        "Render-target attachment disposal",
    );
    // Every RTT carries the hook: the eager guard passes and the hook runs.
    const create = context.functionDeclaration(
        rttModule,
        "_createRenderTargetTexture",
    ).declaration;
    context.expectShapeCount(
        create,
        "rt._disposeAttachments = releaseAttachments",
        "RTT attachment ownership hook",
    );
    context.expectShapeCount(
        create,
        "rt._eager = true",
        "RTT eager allocation",
    );
    const release = context.functionDeclaration(
        rttModule,
        "releaseAttachments",
    ).declaration;
    context.assertStatementShapes(
        release.body!,
        release.body!.statements,
        `
        this._disposed = true;
        try {
            if (color) {
                releaseGPUTexture(color);
            }
        } finally {
            if (depth) {
                releaseGPUTexture(depth);
            }
        }
    `,
        "RTT attachment release",
    );
    return `// ${context.provenance(rttModule, "disposeRenderTargetTexture", `${targetModule}#disposeRenderTarget and ${rttModule}#releaseAttachments`)}
void dispose_render_target_texture(Engine& engine, RenderTargetTexture result) {
    [[maybe_unused]] auto& target = ${recordAt("engine.render_targets", "result.rt")};
    // The attachments: a disposed target hands the hook none again.
    const auto release = [&engine, handle = result.rt] {
        auto& record = ${recordAt("engine.render_targets", "handle")};
        if (record.retired) return;
        record.retired = true;
        ++engine.render_targets_version;
    };
${
    surface
        ? `    if (!target.lifecycle) target.lifecycle = make_render_target_lifecycle(engine, false);
    target.lifecycle->dispose(release);`
        : "    release();"
}
}
`;
}
