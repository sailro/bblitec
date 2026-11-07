// The winding each material family gives a glTF primitive.
//
// The fixture's rows take a StandardMaterial, a ShaderMaterial and a node
// material; its columns are back-culling and double-sided cubes, plain and
// mirrored. The loader marks a mirrored primitive ("cw") and leaves its
// indices as the file has them; each family's pipeline winds that mark as
// it states (left-handed, only PBR reverses it), so a family that does not
// shows the mirrored cube's inside, as the pin does. Registered left- and
// right-handed.
import {
    addToScene,
    createArcRotateCamera,
    createDirectionalLight,
    createEngine,
    createHemisphericLight,
    createSceneContext,
    createShaderMaterial,
    createStandardMaterial,
    loadGltf,
    parseNodeMaterialFromSnippet,
    registerScene,
    startEngine,
} from "@babylonjs/lite";
import { SCENE61_NME_JSON } from "../corpus/babylon-lite/lab/lite/src/shared/scene61-nme.js";

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
        -Math.PI / 2 + 0.5,
        Math.PI / 2.6,
        11,
        { x: 0, y: 0, z: 0 },
    );
    addToScene(scene, createHemisphericLight([0, 1, 0], 0.6));
    addToScene(scene, createDirectionalLight([-0.5, -1, 0.7], 0.8));

    const standard = createStandardMaterial();
    standard.diffuseColor = [0.9, 0.6, 0.3];
    standard.specularColor = [0, 0, 0];
    const shader = createShaderMaterial({
        name: "windingNormals",
        vertexSource: VERTEX,
        fragmentSource: FRAGMENT,
        attributes: ["position", "normal"],
        uniforms: ["worldViewProjection", "world"],
    });
    const node = await parseNodeMaterialFromSnippet(engine, "", {
        json: SCENE61_NME_JSON,
    });

    addToScene(
        scene,
        await loadGltf(
            engine,
            "../examples/assets/regression/gltf-winding.gltf",
        ),
    );
    for (const mesh of scene.meshes) {
        if (mesh.name.startsWith("Standard")) mesh.material = standard;
        else if (mesh.name.startsWith("Shader")) mesh.material = shader;
        else (mesh as { material?: unknown }).material = node;
    }

    await registerScene(scene);
    await startEngine(engine);
}

main().catch(console.error);
