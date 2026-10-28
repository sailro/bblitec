/**
 * The WGSL a MeshLoD program's renderables compose at run time
 * (pbr-mesh-lod-compose.ts `composeMeshLoDWgsl`): every text the program's
 * reachable feature domain composes, executed from the pin at generation.
 * SDL_GPU loads each stage precompiled by its text (`wgsl_stage_stem`);
 * Dawn compiles the run-time text itself.
 *
 * The domain is the pin's own `MeshLoDShaderFeatures`: each boolean member
 * either way, `hasIbl` only with a reachable environment, `fog` only with
 * reachable scene fog, and the tone mapping off or the program's curve (the
 * pin's default curve when the program selects none).
 */
import ts from "typescript";
import { importPinnedModule } from "./pinned-shader-composer.js";
import {
    defaultToneMappingName,
    pinnedToneMapping,
} from "./pinned-tone-mapping.js";
import { sharedUpstreamStore } from "./upstream-source.js";

const COMPOSE = "src/material/pbr/pbr-mesh-lod-compose.ts";

interface MeshLoDComposer {
    composeMeshLoDWgsl: (
        features: Readonly<Record<string, unknown>>,
        toneMapping?: unknown,
    ) => string;
}

/** Each `MeshLoDShaderFeatures` member with the values the program reaches. */
async function featureDomain(
    features: readonly string[],
): Promise<(readonly [string, readonly unknown[]])[]> {
    const declaration = sharedUpstreamStore()
        .getSourceFile(COMPOSE)
        .statements.find(
            (statement): statement is ts.InterfaceDeclaration =>
                ts.isInterfaceDeclaration(statement) &&
                statement.name.text === "MeshLoDShaderFeatures",
        );
    if (!declaration)
        throw new Error(`${COMPOSE}: expected MeshLoDShaderFeatures.`);
    const fog = features.includes("renderer:fog")
        ? await importPinnedModule("material/pbr/pbr-fog-wgsl.js")
        : undefined;
    return declaration.members.map((member) => {
        if (
            !ts.isPropertySignature(member) ||
            !ts.isIdentifier(member.name) ||
            !member.type
        )
            throw new Error(
                `${COMPOSE}: MeshLoDShaderFeatures declares a member generation cannot read.`,
            );
        const name = member.name.text;
        if (member.type.kind === ts.SyntaxKind.BooleanKeyword)
            return [
                name,
                name === "hasIbl" && !features.includes("environment:ibl")
                    ? [false]
                    : [false, true],
            ] as const;
        if (name === "fog" && member.questionToken)
            return [name, fog ? [undefined, fog] : [undefined]] as const;
        throw new Error(
            `${COMPOSE}: MeshLoDShaderFeatures.${name} has no generation domain.`,
        );
    });
}

/** Every distinct WGSL text the program's MeshLoD renderables can compose. */
export async function meshLoDShaderVariants(
    features: readonly string[],
    toneMapping: string | undefined,
): Promise<string[]> {
    const { composeMeshLoDWgsl } = await importPinnedModule<MeshLoDComposer>(
        "material/pbr/pbr-mesh-lod-compose.js",
    );
    const curve = pinnedToneMapping(toneMapping ?? defaultToneMappingName);
    let combinations: Record<string, unknown>[] = [{}];
    for (const [name, values] of await featureDomain(features))
        combinations = combinations.flatMap((combination) =>
            values.map((value) => ({ ...combination, [name]: value })),
        );
    const texts = new Set<string>();
    for (const combination of combinations)
        for (const selected of [undefined, curve])
            texts.add(composeMeshLoDWgsl(combination, selected));
    return [...texts];
}
