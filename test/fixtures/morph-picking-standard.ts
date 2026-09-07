import {createEngine,createSceneContext,createArcRotateCamera,createMeshFromData,
    createStandardMaterial,createMorphTargets,setMorphTargetWeights,addToScene,
    registerScene,startEngine,createGpuPicker,pickAsync,disposePicker} from "@babylonjs/lite";

async function main() {
    const canvas=document.getElementById('renderCanvas') as HTMLCanvasElement;
    const engine=await createEngine(canvas);
    const scene=createSceneContext(engine);
    scene.clearColor={r:.1,g:.1,b:.1,a:1};
    const camera=createArcRotateCamera(-Math.PI/2,Math.PI/2,4,{x:0,y:0,z:0});
    scene.camera=camera;
    const mesh=createMeshFromData(engine,'immediate-morph',
        new Float32Array([-.4,-.4,0,.4,-.4,0,-.4,.4,0,.4,.4,0]),
        new Float32Array([0,0,-1,0,0,-1,0,0,-1,0,0,-1]),new Uint32Array([0,1,2,1,3,2]));
    mesh.position.x=-1;
    const material=createStandardMaterial();
    material.diffuseColor=[1,.2,.1];
    material.emissiveColor=[1,.2,.1];
    material.backFaceCulling=false;
    mesh.material=material;
    const morph=createMorphTargets(engine,[{positions:new Float32Array([2,0,0,2,0,0,2,0,0,2,0,0]),normals:null}],4,[0]);
    mesh.morphTargets=morph;
    addToScene(scene,mesh);
    await registerScene(scene);
    await startEngine(engine);
    await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
    const picker=createGpuPicker(scene);
    const left=canvas.clientWidth/3,right=canvas.clientWidth*2/3,y=canvas.clientHeight/2;
    if(!(await pickAsync(picker,left,y)).hit) throw new Error('rest pose was not picked');
    setMorphTargetWeights(engine,morph,new Float32Array([1]));
    // No RAF between the write and the two observations.
    if(!(await pickAsync(picker,right,y)).hit) throw new Error('same-turn morph write was not picked');
    if((await pickAsync(picker,left,y)).hit) throw new Error('old morph pose survived the write');
    setMorphTargetWeights(engine,morph,new Float32Array([0]));
    if(!(await pickAsync(picker,left,y)).hit) throw new Error('same-turn morph reset was not picked');
    disposePicker(picker);
    canvas.dataset.ready='true';
}
void main();
