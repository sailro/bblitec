import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import { materialGroupIdentity } from "./material-group-identity.js";
import { recordAt } from "../compiler/record-access.js";

/** Family reads use the builder identities retained by native material factories. */
export function lowerMaterialPredicate(
    context: LoweringContext,
    api: "isShaderMaterial" | "isStandardMaterial",
    name: string,
): { prototype: string; lines: string[] } {
    const familyModule = "src/material/material-family.ts";
    const family = context.functionDeclaration(
        familyModule,
        "getMaterialFamily",
    );
    const guardModule = "src/material/material-guards.ts";
    const guard = context.functionDeclaration(guardModule, api);
    const standard = materialGroupIdentity(context, "standard");
    const shader = materialGroupIdentity(context, "shader");
    const familyRead =
        `source.source_pbr_group_builder ? std::optional<std::string>{"pbr"} : ` +
        `source.source_group_builder == ${standard} ? std::optional<std::string>{"standard"} : ` +
        `source.source_group_builder == ${shader} ? std::optional<std::string>{"shader"} : ` +
        `source.source_group_builder >= 4 ? std::optional<std::string>{"node"} : std::nullopt`;
    const familyBody = lowerPinnedBody(
        family.file,
        family.declaration.body!.statements,
        {
            bindings: new Map(),
            calls: new Map(),
            expression(node) {
                if (
                    context.expressionMatchesShape(
                        node,
                        "getMaterialSource(material)._buildGroup?._materialFamily",
                    )
                )
                    return `(${familyRead})`;
                return undefined;
            },
            returnValue(node, lowerer) {
                if (!node)
                    return context.contractError(
                        family.declaration,
                        "Expected a material family result.",
                    );
                return lowerer.expression(node);
            },
        },
    );
    const guardBody = lowerPinnedBody(
        guard.file,
        guard.declaration.body!.statements,
        {
            bindings: new Map([["material", { cpp: "input", type: "opaque" }]]),
            calls: new Map([["getMaterialFamily", () => "family"]]),
            returnValue(node, lowerer) {
                if (!node)
                    return context.contractError(
                        guard.declaration,
                        "Expected a material predicate result.",
                    );
                return lowerer.expression(node);
            },
        },
    );
    const signature = `bool ${name}(bbl::Engine& engine, bbl::MaterialHandle handle)`;
    return {
        prototype: `${signature};`,
        lines: [
            `// ${context.provenance(familyModule, "getMaterialFamily")}`,
            `// ${context.provenance(guardModule, api)}`,
            `${signature} {`,
            `    const auto& input = ${recordAt("engine.materials", "handle")};`,
            // Native material views retain their underlying source handle.
            `    const auto& source = input.source_material.value == bbl::invalid_handle ? input : ${recordAt("engine.materials", "input.source_material")};`,
            `    const auto family = [&]() -> std::optional<std::string> {`,
            familyBody,
            `    }();`,
            guardBody,
            `}`,
        ],
    };
}
