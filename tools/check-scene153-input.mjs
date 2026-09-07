#!/usr/bin/env node
// Original source: autonomous motion, frozen lifetime and deterministic window resize.
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {PNG} from 'pngjs';
import {compareImages} from '../dist/src/parity.js';
import {resolveNativeExecutable,spawnNativeMeasured,verifyBuildIdentity,verifyDeployedPayload} from '../dist/src/parity-scene.js';
const [mode,executableArgument,generatedArgument]=process.argv.slice(2);
assert(['frozen','live'].includes(mode)&&executableArgument&&generatedArgument,
 'Usage: node tools/check-scene153-input.mjs frozen|live <executable> <generated-directory>');
const executable=resolveNativeExecutable(executableArgument);
const generated=resolve(generatedArgument);
verifyDeployedPayload(executable,generated);
const output=resolve(`artifacts/scene153-input/${mode}`);
mkdirSync(output,{recursive:true});
const phases=[{name:'early',frame:5,replay:[]},{name:'later',frame:40,replay:[]},
 {name:'resize',frame:40,replay:[...Array(10).fill('-'),'WindowResize@960:540']}];
const rectangle=path=>{
 const image=PNG.sync.read(readFileSync(path));
 let left=image.width,right=-1,top=image.height,bottom=-1;
 for(let y=0;y<image.height;y++)for(let x=0;x<image.width;x++){
  const i=(y*image.width+x)*4;
  if(image.data[i]>200&&image.data[i+1]>120&&image.data[i+2]<120){
   left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
  }
 }
 assert(right>left&&bottom>top,'Missing animated rectangle');
 return {width:image.width,height:image.height,x:(left+right+1)/2,y:(top+bottom+1)/2,size:(right-left+1),
  position:((left+right+1)/2-image.width/2)/(image.width*.18)};
};
const results=[];
for(const backend of ['sdl_gpu','dawn']){
 const captures=new Map();
 for(const phase of phases){
  const stem=resolve(output,`${backend}-${phase.name}`);
  for(const suffix of ['.png','.json','.build-stamp'])rmSync(stem+suffix,{force:true});
  const log=spawnNativeMeasured(executable,{
   BBLITE_GPU_BACKEND:backend,BBLITE_TEST_PASS:'0',BBLITE_MAX_FRAMES:String(phase.frame+1),
   BBLITE_SCREENSHOT_FRAME:String(phase.frame),BBLITE_SCREENSHOT:stem+'.png',BBLITE_RENDER_CAPTURE:stem+'.json',
   BBLITE_BUILD_STAMP_OUT:stem+'.build-stamp',BBLITE_FRAME_DELTA_MS:'16',BBLITE_ANIMATION_SEEK_SECONDS:'',
   BBLITE_INPUT_REPLAY:phase.replay.join(','),BBLITE_RUNTIME_TRACE:'1',BBLITE_GPU_DEBUG:'1',SDL_ASSERT:'always_ignore'
  },[],true,20000);
  writeFileSync(stem+'.log',log);
  assert(!/validation error|gpu error|exception/i.test(log),log);
  verifyBuildIdentity(executable,generated,stem+'.build-stamp');
  const box=rectangle(stem+'.png');
  assert(Math.abs(box.y-box.height/2)<1,'Rectangle left its horizontal track');
  assert(Math.abs(box.size-Math.max(28,Math.min(box.width,box.height)*.09))<2,'Rectangle did not resize from live canvas dimensions');
  captures.set(phase.name,{image:stem+'.png',...box});
 }
 const early=captures.get('early'),later=captures.get('later'),resized=captures.get('resize');
 const motion=compareImages(early.image,later.image).mad;
 assert.equal(resized.width,960);assert.equal(resized.height,540);
 assert(Math.abs(later.position-resized.position)<.01,'Resize changed the animation pose');
 if(mode==='frozen'){
  assert.equal(motion,0,'Frozen branch continued animating');
  assert(Math.abs(later.position-2)<.01,'Frozen branch did not seek the source target');
 }else{
  assert(motion>.2,'Autonomous manager did not change the rendered image');
  assert(later.position-early.position>1,'Autonomous manager did not advance the target');
 }
 results.push({backend,mode,motion,early,later,resized});
}
writeFileSync(resolve(output,'verification.json'),JSON.stringify(results,null,2)+'\n');
console.log(JSON.stringify(results,null,2));
