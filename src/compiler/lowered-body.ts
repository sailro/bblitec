import { outlineEmittedBody } from "./body-outlining.js";
import {
    renderNativeEmission,
    verbatimEmission,
    type NativeStatement,
} from "./native-statements.js";

/** Opaque fragments stay in place; explicitly scoped regions use the shared outliner. */
export function outlineLoweredBody(
    name: string,
    source: string,
    parts: readonly (
        string | Omit<Extract<NativeStatement, { kind: "region" }>, "kind">
    )[],
): { body: string; definitions: string } {
    let index = 0;
    const outlined = outlineEmittedBody({
        body: parts.map((part) =>
            typeof part === "string"
                ? verbatimEmission(part)
                : {
                      statement: { kind: "region", ...part },
                      indent: "",
                  },
        ),
        parameters: [],
        bindingType: () => undefined,
        allocateName: () => `${name}_segment_${index++}`,
        source,
        callNamespace: "",
    });
    return {
        body: outlined.body.map(renderNativeEmission).join(""),
        definitions: outlined.segments
            .map((segment) => segment.lines.join("\n"))
            .join("\n\n"),
    };
}
