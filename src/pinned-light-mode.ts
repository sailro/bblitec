/**
 * Which light arm one PBR renderable composes, stated once.
 *
 * `pbr-renderable.ts`'s `rebuildSingle` resolves
 * `lightCount === 0 ? 0 : lightCount === 1 && !receiveShadows ? 1 : 2` — a
 * receiver's shadow factor is applied inside the multi-light loop, so one
 * affecting light does not put it on the single-light arm.
 *
 * Two consumers need that rule and they must not disagree: the runtime
 * derives it per draw to key the composed variant table, and generation
 * derives its inverse to decide which (mesh, arm) pairs to compose at all. A
 * mismatch is a hard draw refusal rather than a compile error, so the C++
 * half is not a second spelling — `pinnedLightModeCpp` enumerates THIS
 * function over its whole domain and emits the answers.
 */
import ts from "typescript";
import { LoweringContext } from "./lowering/context.js";
import { sharedUpstreamStore } from "./upstream-source.js";

export type PinnedLightMode = 0 | 1 | 2;

const pbrRenderableModule = "src/material/pbr/pbr-renderable.ts";

/**
 * The rule as `rebuildSingle` spells it. `pinnedPbrLightMode` below is
 * its restatement, and this text is what anchors that restatement to the
 * pin: the initializer is compared structurally on first use, so a pin
 * that changes the arm selection fails generation instead of leaving
 * both consumers agreeing with each other and not with upstream.
 */
const pinnedLightModeRule =
    "lightCount === 0 ? 0 : lightCount === 1 && !receiveShadows ? 1 : 2";

let anchored = false;

function anchorPinnedLightMode(): void {
    if (anchored) return;
    const context = new LoweringContext(sharedUpstreamStore());
    const file = context.sourceFile(pbrRenderableModule);
    const declarations = (
        root: ts.Node,
        name: string,
    ): (ts.VariableDeclaration & { initializer: ts.Expression })[] =>
        context.findNodes(
            root,
            (node): node is ts.VariableDeclaration & {
                initializer: ts.Expression;
            } =>
                ts.isVariableDeclaration(node) &&
                ts.isIdentifier(node.name) &&
                node.name.text === name &&
                node.initializer !== undefined,
        );
    const rebuilds = declarations(file, "rebuildSingle");
    const rebuild = rebuilds[0];
    if (rebuilds.length !== 1 || !rebuild) {
        return context.contractError(
            file,
            "Expected pbr-renderable.ts to declare rebuildSingle once.",
        );
    }
    const lightModes = declarations(rebuild, "lightMode");
    const lightMode = lightModes[0];
    if (lightModes.length !== 1 || !lightMode) {
        return context.contractError(
            rebuild,
            "Expected rebuildSingle to derive lightMode once.",
        );
    }
    context.assertExpressionShape(
        lightMode.initializer,
        pinnedLightModeRule,
        "rebuildSingle's light mode",
    );
    anchored = true;
}

export function pinnedPbrLightMode(
    lightCount: number,
    receivesShadows: boolean,
): PinnedLightMode {
    anchorPinnedLightMode();
    if (lightCount === 0) return 0;
    return lightCount === 1 && !receivesShadows ? 1 : 2;
}

/**
 * Whether a SHADOW-RECEIVING mesh can reach one of the scene's composed arms.
 *
 * The arm list is already the set the scene reaches; what the receive bit
 * changes is which of them a receiving mesh can land on, so this asks only
 * about that delta and a non-receiver is never filtered here.
 *
 * The light count is a run-time quantity, so what generation can answer is
 * "does SOME count give this arm". `canHaveNoAffectingLight` is the port's
 * own half: `light_affects_mesh` answers false only for a light naming the
 * meshes it applies to, which two producers fill -- a `.babylon` document's
 * own per-light mesh lists, and scene code writing
 * `light.includedOnlyMeshIds`. With neither, every light in `scene.lights`
 * affects every mesh, and a scene with a shadow generator has at least one.
 */
export function pinnedReceiverReachesArm(
    lightMode: PinnedLightMode,
    canHaveNoAffectingLight: boolean,
): boolean {
    const counts = canHaveNoAffectingLight ? [0, 1, 2] : [1, 2];
    return counts.some(
        (count) => pinnedPbrLightMode(count, true) === lightMode,
    );
}

/**
 * The same rule as a generated C++ lookup, derived by enumeration rather than
 * restated: the buckets are the only three the rule distinguishes, so filling
 * them from the function above is the whole port.
 */
export function pinnedLightModeCpp(): string {
    const row = (receives: boolean): string =>
        [0, 1, 2]
            .map((count) => `${pinnedPbrLightMode(count, receives)}u`)
            .join(", ");
    return `/**
 * The arm one PBR renderable composes, from rebuildSingle's own
 * lightCount === 0 ? 0 : lightCount === 1 && !receiveShadows ? 1 : 2.
 *
 * The table is generation's enumeration of that rule over its whole domain,
 * not a second statement of it: generation decides which (mesh, arm) pairs to
 * compose from the same function, so the two cannot disagree about which
 * variants exist.
 */
inline std::uint32_t pinned_pbr_light_mode(
    std::uint32_t light_count,
    bool receives_shadows) {
    const std::size_t bucket =
        light_count == 0 ? 0u : light_count == 1 ? 1u : 2u;
    static constexpr std::uint32_t modes[2][3] = {
        {${row(false)}},
        {${row(true)}},
    };
    return modes[receives_shadows ? 1 : 0][bucket];
}`;
}
