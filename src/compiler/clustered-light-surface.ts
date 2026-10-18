import type ts from "typescript";
import { clusteredOptionFields } from "../lowering/clustered-light-lowerer.js";
import { sharedPinnedContext } from "../lowering/context.js";
import type { LoweringServices } from "./lowering-services.js";
import type { Value } from "./types.js";

/** Point and spot records expose the pin's numeric fields and retained tuples. */
export function clusteredLightProperty(
    context: Pick<LoweringServices, "requireEngine" | "reachFeature">,
    owner: Value,
    property: string,
    at: ts.Node,
): Value | undefined {
    if (owner.kind !== "clustered-light") return undefined;
    const field = clusteredOptionFields(
        sharedPinnedContext(),
        "ClusteredSpotLight",
    ).find((candidate) => candidate.name === property);
    if (!field) return undefined;
    const engineCpp = context.requireEngine(owner, at);
    context.reachFeature("light:clustered", at);
    return {
        kind: field.kind === "number" ? "number" : "data",
        cpp: `bbl::clustered_light(${engineCpp}, ${owner.cpp}).${field.name}`,
        engineCpp,
        dataType:
            field.kind === "number"
                ? { kind: "number" }
                : { kind: "tuple", arity: 3 },
    };
}
