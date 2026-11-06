// Right-handed ShaderMaterial winding under the mirrored-mesh opt-in (built
// under `babylon-lite-rh`).
//
// A right-handed engine winds procedural geometry "cw" behind its mirroring
// view matrix; `enableMirroredMeshes` keeps a mirrored mesh's winding mark
// live for a ShaderMaterial, whose pipeline keys it "|ccw"
// (`shader-pipeline.ts`). The material colours faces by their world
// normal, so a reversed winding shows the box's inside.
import {
    addToScene,
    createArcRotateCamera,
    createBox,
    createEngine,
    createSceneContext,
    createShaderMaterial,
    enableMirroredMeshes,
    registerScene,
    startEngine,
} from "@babylonjs/lite";

const VERTEX = `struct VertexOutput{@builtin(position) position:vec4<f32>,@location(0) normal:vec3<f32>,};
@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;out.position=shaderSystem.worldViewProjection*vec4<f32>(input.position,1.0);out.normal=(shaderSystem.world*vec4<f32>(input.normal,0.0)).xyz;return out;}`;
const FRAGMENT = `struct VertexOutput{@builtin(position) position:vec4<f32>,@location(0) normal:vec3<f32>,};
@fragment fn mainFragment(input:VertexOutput)->@location(0) vec4<f32>{return vec4<f32>(normalize(input.normal)*0.5+vec3<f32>(0.5),1.0);}`;

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.1, g: 0.11, b: 0.16, a: 1 };

    scene.camera = createArcRotateCamera(
        -Math.PI / 2 + 0.6,
        Math.PI / 3,
        5,
        { x: 0, y: 0, z: 0 },
    );

    const material = createShaderMaterial({
        name: "windingNormals",
        vertexSource: VERTEX,
        fragmentSource: FRAGMENT,
        attributes: ["position", "normal"],
        uniforms: ["worldViewProjection", "world"],
    });

    // A procedural box, and its mirror image.
    const box = (x: number) => {
        const mesh = createBox(engine, 1);
        mesh.position.set(x, 0, 0);
        mesh.material = material;
        addToScene(scene, mesh);
        return mesh;
    };
    box(-0.9);
    box(0.9).scaling.set(-1, 1, 1);
    await enableMirroredMeshes(scene);

    await registerScene(scene);
    await startEngine(engine);
}

main().catch(console.error);
