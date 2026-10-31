/**
 * A call to the generated camera scalar setter, which versions the camera
 * on a changed value. `qualified` spells it from outside namespace `bbl`.
 */
export function cameraScalarWrite(
    record: string,
    field: string,
    value: string,
    qualified = false,
): string {
    const bbl = qualified ? "bbl::" : "";
    return `${bbl}write_camera_scalar(${record}, &${bbl}CameraRecord::${field}, ${value})`;
}

/** A call to the generated setter of one camera vector component. */
export function cameraVectorComponentWrite(
    record: string,
    vector: string,
    axis: string,
    value: string,
    qualified = false,
): string {
    const bbl = qualified ? "bbl::" : "";
    return `${bbl}write_camera_vector_component(${record}, &${bbl}CameraRecord::${vector}, &${bbl}Vec3d::${axis}, ${value})`;
}
