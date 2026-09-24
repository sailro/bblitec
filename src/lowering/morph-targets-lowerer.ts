/**
 * `createMorphTargets`'s deltas payload, translated from the pin.
 *
 * Both backends upload the storage buffer the pinned morph fragment reads,
 * so the packing -- one `F32` of `MORPH_FLOATS_PER_VERTEX` lanes per
 * (target, vertex), position then normal, a target without normals leaving
 * its three lanes zero -- is the pin's own loop over its own allocation.
 * What this port supplies is where a target's lanes come from: native
 * geometry keeps each target as `Vec3` deltas, read through
 * `MorphTargetLanes` as the pin's flat `Float32Array` lanes in native
 * vertex space.
 */
import ts from "typescript";
import { statementKind, type LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import type { PinnedBinding } from "./pinned-numeric-lowerer.js";
import { pinnedHeader } from "./pinned-header.js";

const morphModule = "src/morph/create-morph-targets.ts";

/** The pinned statements that build `deltaData`, and its local's name. */
function deltaStatements(
    context: LoweringContext,
    declaration: ts.FunctionDeclaration,
): readonly ts.Statement[] {
    const statements = declaration.body!.statements;
    const upload = statements.findIndex(
        (statement) =>
            ts.isVariableStatement(statement) &&
            statement.declarationList.declarations.some(
                (entry) =>
                    ts.isIdentifier(entry.name) &&
                    entry.name.text === "deltasBuffer",
            ),
    );
    const selected = statements.slice(0, Math.max(upload, 0));
    if (
        upload < 0 ||
        selected.map(statementKind).join(",") !==
            "variable statement,variable statement,for statement"
    ) {
        context.contractError(
            declaration,
            "Expected createMorphTargets to count its targets, allocate " +
                "deltaData and fill it in one loop before uploading it as " +
                "deltasBuffer.",
        );
    }
    return selected;
}

/** `upstream::pack_morph_deltas`, for a scene that reached morph storage. */
export function morphTargetsHeader(context: LoweringContext): string {
    const { file, declaration } = context.functionDeclaration(
        morphModule,
        "createMorphTargets",
    );
    const parameters = declaration.parameters.map((parameter) =>
        parameter.name.getText(file),
    );
    if (parameters.join(",") !== "engine,targets,vertexCount,morphWeights") {
        context.contractError(
            declaration,
            "Expected createMorphTargets(engine, targets, vertexCount, " +
                "morphWeights).",
        );
    }
    const bindings = new Map<string, PinnedBinding>([
        [
            "targets.length",
            {
                cpp: "static_cast<double>(geometry.morph_positions.size())",
                type: "scalar",
            },
        ],
        [
            "vertexCount",
            {
                cpp: "static_cast<double>(geometry.vertices.size())",
                type: "scalar",
            },
        ],
    ]);
    const statements = deltaStatements(context, declaration);
    const body = lowerPinnedBody(file, statements, {
        bindings,
        calls: new Map(),
        // `const tgt = targets[t]!`: one target, whose two optional arrays
        // the loop reads lane by lane.
        statement: (statement, lowerer) => {
            if (!ts.isVariableStatement(statement)) return undefined;
            const [entry] = statement.declarationList.declarations;
            const initializer =
                entry?.initializer &&
                context.unwrapExpression(entry.initializer);
            if (
                !entry ||
                !ts.isIdentifier(entry.name) ||
                !initializer ||
                !ts.isElementAccessExpression(initializer) ||
                initializer.expression.getText(file) !== "targets"
            ) {
                return undefined;
            }
            const target = `static_cast<std::size_t>(${lowerer.expression(
                initializer.argumentExpression,
            )})`;
            const lanes = (member: string): string =>
                `bbl::MorphTargetLanes{geometry.${member}, ${target}}`;
            const name = entry.name.text;
            bindings.set(`${name}.positions`, {
                cpp: lanes("morph_positions"),
                type: "f32-view",
            });
            bindings.set(`${name}.normals`, {
                cpp: lanes("morph_normals"),
                type: "f32-view",
                absentCpp: `${target} >= geometry.morph_normals.size()`,
            });
            return [];
        },
    });
    const deltas = bindings.get("deltaData");
    if (deltas?.type !== "f32") {
        context.contractError(
            declaration,
            "Expected createMorphTargets' deltaData to be an F32 buffer.",
        );
    }
    return pinnedHeader(
        ["<bblite/runtime.hpp>", "", "<cstddef>", "<cstdint>", "<vector>"],
        `// ${context.provenance(morphModule, "createMorphTargets", "its deltaData packing")}
inline std::vector<float> pack_morph_deltas(const ModelGeometry& geometry) {
${body}
    return ${deltas.cpp};
}`,
    );
}
