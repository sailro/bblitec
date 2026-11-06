/**
 * `enableGeometryVelocity`'s composition state (`frame-graph/enable-geometry-velocity.ts`).
 *
 * The enabler installs the PBR velocity namespace
 * (`installPbrGeometryVelocity`) and the deformation feature with its
 * previous-depth output (`installGeometryDeformationVelocity`) into module
 * state the geometry composers read, and marks each PBR geometry view the
 * task creates `_geometryVelocity`. Composition runs the same composers with
 * that state set and the view active (`setActiveGeometryVelocityView`) for
 * exactly one synchronous call, then restores what was there, so a variant
 * composed outside a velocity task composes as before.
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
 * Runs `compose` under the state `enableGeometryVelocity` installs, with a
 * velocity view active. Loaded once; `compose` must not await.
 */
export async function pinnedGeometryVelocityScope(): Promise<
    <T>(compose: () => T) => T
> {
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
    return <T>(compose: () => T): T => {
        const previousVelocity = hooks.pbrGeometryVelocity;
        const previousFeature =
            deformationHooks.getGeometryDeformationVelocity();
        const previousOutput = deformationHooks.geometryVelocityOutput;
        hooks.installPbrGeometryVelocity(velocity);
        deformationHooks.installGeometryDeformationVelocity(
            deformation,
            velocity.geometryVelocityOutput,
        );
        const previousView = velocity.setActiveGeometryVelocityView({
            _geometryVelocity: true,
        });
        try {
            return compose();
        } finally {
            velocity.setActiveGeometryVelocityView(previousView);
            deformationHooks.installGeometryDeformationVelocity(
                previousFeature,
                previousOutput,
            );
            hooks.installPbrGeometryVelocity(previousVelocity);
        }
    };
}
