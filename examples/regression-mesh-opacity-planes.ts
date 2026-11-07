// The mesh opacity regressions' shared pieces: a matte Standard material and
// a faded plane that may cross back to 1 after registration.
import {
    addToScene,
    createPlane,
    createStandardMaterial,
    onBeforeRender,
    setMeshOpacity,
    type EngineContext,
    type Mesh,
    type PbrMaterialProps,
    type SceneContext,
    type StandardMaterialProps,
} from "babylon-lite";

/** A Standard material of one diffuse colour and no specular highlight. */
export function standard(r: number, g: number, b: number): StandardMaterialProps {
    const material = createStandardMaterial();
    material.diffuseColor = [r, g, b];
    material.specularColor = [0, 0, 0];
    return material;
}

/** A plane at `opacity` in `scene`. */
export function fadedPlane(
    engine: EngineContext,
    scene: SceneContext,
    width: number,
    height: number,
    x: number,
    y: number,
    z: number,
    material: StandardMaterialProps | PbrMaterialProps,
    opacity: number
): Mesh {
    const mesh = createPlane(engine, { width, height });
    mesh.position.set(x, y, z);
    mesh.material = material;
    setMeshOpacity(mesh, opacity);
    addToScene(scene, mesh);
    return mesh;
}

/** Writes opacity 1 to `mesh` on the third frame. */
export function restoreOnThirdFrame(scene: SceneContext, mesh: Mesh): void {
    let frame = 0;
    onBeforeRender(scene, () => {
        frame += 1;
        if (frame === 3) setMeshOpacity(mesh, 1);
    });
}
