import type ts from "typescript";
import type { LoweringServices } from "./lowering-services.js";

/** The effect task methods scene code can read, bind and replace. */
export function isEffectTaskMethodName(
    name: string,
): name is "record" | "dispose" {
    return name === "record" || name === "dispose";
}

/** What a method slot reaches: `dispose` also releases the task and its targets. */
export function reachEffectTaskMethod(
    context: Pick<LoweringServices, "reachFeature">,
    dispose: boolean,
    node: ts.Node,
): void {
    context.reachFeature("frame-graph:task-method-slots", node);
    if (!dispose) return;
    context.reachFeature("frame-graph:task-disposal", node);
    context.reachFeature("frame-graph:target-disposal", node);
}
