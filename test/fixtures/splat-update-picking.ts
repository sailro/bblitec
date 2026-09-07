import {createEngine,createSceneContext,createArcRotateCamera,loadSplat,
    createSphere,createGround,createStandardMaterial,addToScene,
    registerScene,startEngine,createGpuPicker,pickAsync,disposePicker} from "@babylonjs/lite";

async function main() {
    const canvas=document.getElementById('renderCanvas') as HTMLCanvasElement;
    const engine=await createEngine(canvas);
    const scene=createSceneContext(engine);
    scene.clearColor={r:0,g:0,b:0,a:1};
    scene.camera=createArcRotateCamera(-1,1,10,{x:0,y:0,z:0});
    // The pin's cloud contributor uses a less-depth pipeline on the shared
    // zero-cleared target. Ordinary contributors establish its depth, as in129.
    const material=createStandardMaterial();
    const sphere=createSphere(engine,{diameter:1,segments:32});
    sphere.name='sphere';sphere.position.y=.5;sphere.position.z=-1;sphere.material=material;
    addToScene(scene,sphere);
    const ground=createGround(engine,{width:6,height:6});
    ground.name='ground';ground.material=material;addToScene(scene,ground);
    const cloud=await loadSplat(scene,'https://cdn.jsdelivr.net/gh/CedricGuillemet/dump@master/Halo_Believe.splat');
    cloud.name='updated-cloud';
    cloud.position.y=1.7;
    await registerScene(scene);
    await startEngine(engine);
    await cloud.firstSortReady;
    await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
    const picker=createGpuPicker(scene);
    let x=0,y=0,found=false;
    for(let row=1;row<=6;row++){
        for(let column=1;column<=6;column++){
            if(!found){
                const candidateX=canvas.clientWidth*column/7;
                const candidateY=canvas.clientHeight*row/7;
                const info=await pickAsync(picker,candidateX,candidateY);
                if(info.hit&&(info.pickedMesh?.name??'')==='updated-cloud'){
                    x=candidateX;y=candidateY;found=true;
                }
            }
        }
    }
    if(!found)throw new Error('initial cloud was not picked');
    const data=cloud.splatsData;
    const original=new Uint8Array(data).slice().buffer;
    const positions=new Float32Array(data);
    for(let row=0;row<positions.length/8;row++)positions[row*8+1]!+=100;
    cloud.updateData(data);
    // Each pick starts immediately after updateData, before another RAF.
    const moved=await pickAsync(picker,x,y);
    if((moved.pickedMesh?.name??'')==='updated-cloud')throw new Error('old splat texture survived the update');
    cloud.updateData(original);
    const restored=await pickAsync(picker,x,y);
    if((restored.pickedMesh?.name??'')!=='updated-cloud')throw new Error('same-turn splat reset was not picked');
    disposePicker(picker);
    console.log('splat-update-picking: ok');
    canvas.dataset.ready='true';
}
void main();
