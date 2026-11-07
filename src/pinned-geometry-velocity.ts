/**
 * `enableGeometryVelocity`'s composition state (`frame-graph/enable-geometry-velocity.ts`).
 *
 * The enabler installs the PBR velocity namespace
 * (`installPbrGeometryVelocity`) and the deformation feature with its
 * previous-depth output (`installGeometryDeformationVelocity`) into module
 * state the geometry composers read, and marks each PBR geometry view the
 * task creates `_geometryVelocity`. The Standard composer reads the
 * installed output and feature directly, so every Standard LINEAR_VELOCITY
 * view of the program composes from them. Without the enabler, a Standard
 * task's preload loads the deformation feature alone when its mesh list holds
 * a skinned or morphed mesh (`preloadGeometryDeformationVelocity`). Composition runs the same composers
 * with that state set and the view active (`setActiveGeometryVelocityView`)
 * for exactly one synchronous call, then restores what was there, so a
 * variant composed outside a velocity task composes as before.
 */
import {
    importPinnedModule,
    pinnedSourceModule,
} from "./pinned-shader-composer.js";

/** The pinned modules the enabler installs from, by source path. */
export const GEOMETRY_VELOCITY_MODULE =
    "src/frame-graph/enable-geometry-velocity.ts";
export const PBR_GEOMETRY_VELOCITY_MODULE =
    "src/material/pbr/pbr-geometry-velocity.ts";
export const GEOMETRY_DEFORMATION_VELOCITY_MODULE =
    "src/material/geometry-deformation-velocity.ts";

interface PbrVelocityModule {
    setActiveGeometryVelocityView(view: object | null): object | null;
    geometryVelocityOutput: unknown;
}
interface PbrVelocityHooks {
    readonly pbrGeometryVelocity: unknown;
    installPbrGeometryVelocity(velocity: unknown): void;
}
interface DeformationHooks {
    readonly geometryVelocityOutput: unknown;
    installGeometryDeformationVelocity(feature: unknown, output: unknown): void;
    getGeometryDeformationVelocity(): unknown;
}

let loaded:
    | Promise<{
          velocity: PbrVelocityModule;
          deformation: unknown;
          hooks: PbrVelocityHooks;
          deformationHooks: DeformationHooks;
      }>
    | undefined;

/**
 * The module state a composition runs under: `enableGeometryVelocity`'s
 * (the PBR namespace, the deformation feature and its previous-depth output,
 * with a velocity view active), or a Standard task preload's
 * (`preloadGeometryDeformationVelocity` loads the deformation feature
 * alone).
 */
export type GeometryVelocityState = "enabler" | "preload";

/**
 * Runs `compose` under `state`. Loaded once; `compose` must not await.
 */
export async function pinnedGeometryVelocityScope(
    state: GeometryVelocityState = "enabler",
): Promise<<T>(compose: () => T) => T> {
    loaded ??= Promise.all([
        importPinnedModule<PbrVelocityModule>(
            pinnedSourceModule(PBR_GEOMETRY_VELOCITY_MODULE),
        ),
        importPinnedModule<unknown>(
            pinnedSourceModule(GEOMETRY_DEFORMATION_VELOCITY_MODULE),
        ),
        importPinnedModule<PbrVelocityHooks>(
            "material/pbr/pbr-geometry-velocity-hooks.js",
        ),
        importPinnedModule<DeformationHooks>(
            "material/geometry-deformation-hooks.js",
        ),
    ]).then(([velocity, deformation, hooks, deformationHooks]) => ({
        velocity,
        deformation,
        hooks,
        deformationHooks,
    }));
    const { velocity, deformation, hooks, deformationHooks } = await loaded;
    const enabler = state === "enabler";
    return <T>(compose: () => T): T => {
        const previousVelocity = hooks.pbrGeometryVelocity;
        const previousFeature =
            deformationHooks.getGeometryDeformationVelocity();
        const previousOutput = deformationHooks.geometryVelocityOutput;
        if (enabler) hooks.installPbrGeometryVelocity(velocity);
        deformationHooks.installGeometryDeformationVelocity(
            deformation,
            enabler ? velocity.geometryVelocityOutput : previousOutput,
        );
        const previousView = enabler
            ? velocity.setActiveGeometryVelocityView({
                  _geometryVelocity: true,
              })
            : null;
        try {
            return compose();
        } finally {
            if (enabler) velocity.setActiveGeometryVelocityView(previousView);
            deformationHooks.installGeometryDeformationVelocity(
                previousFeature,
                previousOutput,
            );
            hooks.installPbrGeometryVelocity(previousVelocity);
        }
    };
}
