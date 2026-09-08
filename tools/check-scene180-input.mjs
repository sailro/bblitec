#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createSuiteSceneServer,suiteBrowserModule} from '../dist/src/capture-suite-reference.js';
import {screenshotCaptureBrowserArgs,waitForSceneReady,withBrowserPage} from '../dist/src/browser-harness.js';
import {adHocCaptureEnvironment} from '../dist/src/capture-timing.js';
import {compareImages,compareRegion} from '../dist/src/parity.js';
import {resolveNativeExecutable,spawnNativeMeasured,verifyBuildIdentity,verifyDeployedPayload} from '../dist/src/parity-scene.js';

const output=resolve(process.argv[2]??'artifacts/scene180-input');
const generated=resolve(process.argv[3]??'generated/scene180');
const executable=resolveNativeExecutable(process.argv[4]??'native/build-scene180-release/bblite_native.exe');
mkdirSync(output,{recursive:true});verifyDeployedPayload(executable,generated);
const sourcePath='corpus/babylon-lite/lab/lite/src/lite/scene180.ts',canonical=suiteBrowserModule(sourcePath);
const marker='registerTextRenderer(tr);';assert.equal(canonical.split(marker).length,2);
const observed=canonical.replace(marker,`${marker}\nwindow.__textRendererObserver={data,layer,tr,engine};`);
writeFileSync(join(output,'canonical-module.js'),canonical);writeFileSync(join(output,'observed-module.js'),observed);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const pause=count=>Array(count).fill('-');
const click=(x,y)=>({kind:'click',x,y,replay:[`UiClick@${x}:${y}`]});
const edit=text=>({kind:'edit',text,replay:['UiClick@80:50','UiKey@Ctrl+A',text?`UiText@${Buffer.from(text).toString('hex')}`:'UiKey@Backspace','UiClick@640:600']});
const drag=(x,y,toX,toY)=>({kind:'drag',x,y,toX,toY,replay:[`+UiMouseLeft@${x}:${y}`,`UiMove@${toX}:${toY}`,`-UiMouseLeft@${toX}:${toY}`]});
const weight40=click(445,97),red25=click(431,127),green50=click(454,157),blue75=click(476,187);
const phases=[
    {name:'initial',actions:[],full:true},
    {name:'weight-zero',actions:[click(409,97)]},
    {name:'weight',actions:[weight40]},
    {name:'weight-max',actions:[click(499,97)]},
    {name:'weight-clear',actions:[weight40,click(409,97)]},
    {name:'color',actions:[red25,green50,blue75]},
    {name:'weighted-color',actions:[weight40,red25,green50,blue75]},
    {name:'weighted-edit',actions:[weight40,red25,edit('AV ffi Ω Ж\nLive color and weight.')]},
    {name:'empty',actions:[weight40,edit('')]},
    {name:'regrow',actions:[weight40,edit(''),edit('New é Résumé\nText after an empty run.')]},
    {name:'rotation',actions:[click(476,37)]},
    {name:'opacity',actions:[click(454,67)]},
    {name:'drag',actions:[drag(750,600,850,640)]},
    {name:'scale',actions:[{kind:'wheel',replay:['UiWheelUp']}]},
    {name:'window-resize',actions:[{kind:'resize',replay:['WindowResize@960:600']}]},
    {name:'textarea-resize',actions:[drag(304,162,304,242)],full:true},
].filter(phase=>!process.env.BBLITE_TEXT_CONTROL_PHASES||process.env.BBLITE_TEXT_CONTROL_PHASES.split(',').includes(phase.name));
const frames=(page,count)=>page.evaluate(async count=>{for(let i=0;i<count;i++)await new Promise(requestAnimationFrame);},count);
const records=await withBrowserPage(createSuiteSceneServer(observed,{sourcePath,hostPage:'corpus/babylon-lite/lab/lite/scene180.html'}),{
    serverName:'standalone text controls',browserArgs:screenshotCaptureBrowserArgs,viewport:{width:1280,height:720},pageErrorPrefix:'TextRenderer observer',
},async(page,origin)=>{
    await page.addInitScript(()=>{
        const original=GPUQueue.prototype.writeBuffer;
        GPUQueue.prototype.writeBuffer=function(buffer,offset,data,dataOffset,size){
            if(buffer.label==='text-layer-ubo'){
                const bytes=data instanceof ArrayBuffer?new Uint8Array(data):new Uint8Array(data.buffer,data.byteOffset,data.byteLength);
                const unit=data instanceof ArrayBuffer||data instanceof DataView?1:data.BYTES_PER_ELEMENT;
                const begin=(dataOffset??0)*unit,count=size===undefined?bytes.byteLength-begin:size*unit;
                const retained=window.__textUniform??=new Uint8Array(96);retained.set(bytes.subarray(begin,begin+count),offset);
            }
            return original.apply(this,arguments);
        };
    });
    const results=[];
    for(const phase of phases){
        await page.setViewportSize({width:1280,height:720});await waitForSceneReady(page,origin,false);
        if(phase.name==='initial'){
            await page.screenshot({path:join(output,'observed.png')});
            assert.equal(compareImages(join(output,'observed.png'),'reference/scene180/babylon-lite-golden.png').mad,0,'Observer changed the unchanged source image');
        }
        for(const action of phase.actions){
            if(action.kind==='click')await page.mouse.click(action.x,action.y);
            if(action.kind==='edit'){await page.locator('#textInput').fill(action.text);await page.mouse.click(640,600);}
            if(action.kind==='drag'){await page.mouse.move(action.x,action.y);await page.mouse.down();await page.mouse.move(action.toX,action.toY);await page.mouse.up();}
            if(action.kind==='wheel'){await page.mouse.move(640,360);await page.mouse.wheel(0,-100);}
            if(action.kind==='resize')await page.setViewportSize({width:960,height:600});
            await frames(page,8);
        }
        await frames(page,120);
        const state=await page.evaluate(()=>{
            const {data,layer,engine}=window.__textRendererObserver;
            const group=data._groups[0],ids=new Map([...group._curveSet._atlas._glyphSlots].map(([id,slot])=>[slot._index,id]));
            const instances=Array.from({length:data._instanceCount},(_,i)=>{const word=data._instancesU32[i*3+2];return word===0xffffffff?null:[ids.get(word&0xffff),data._instances[i*3],data._instances[i*3+1],word>>>16];});
            const form=document.getElementById('textInput').getBoundingClientRect();
            return {instances,styles:Array.from(data._styles),uniform:Array.from(window.__textUniform),
                layer:{position:layer.positionPx,scale:layer.scale,rotation:layer.rotationRad,opacity:layer.opacity},
                viewport:{width:engine.canvas.width,height:engine.canvas.height},form:{width:form.width,height:form.height},
                values:Object.fromEntries(['weight','rot','opacity','red','green','blue'].map(id=>[id,document.getElementById(id).value]))};
        });
        if(!phase.full)await page.addStyleTag({content:'#panel{visibility:hidden!important}'});
        await page.screenshot({path:join(output,`browser-${phase.name}.png`)});results.push({...phase,state});
    }
    return results;
});
writeFileSync(join(output,'browser-observations.json'),JSON.stringify(records,null,2)+'\n');
const manifest=JSON.parse(readFileSync(join(generated,'manifest.json'),'utf8'));
const ids=new Map(manifest.textData[0].live.glyphSlots.map((slot,id)=>[slot,id])),summaries=[];
for(const backend of ['sdl_gpu','dawn'])for(const phase of records){
    const stem=join(output,`${backend}-${phase.name}`),replay=[...pause(20),...phase.actions.flatMap(action=>[...action.replay,...pause(8)])].join(',');
    const log=spawnNativeMeasured(executable,{...adHocCaptureEnvironment(),BBLITE_GPU_BACKEND:backend,BBLITE_TEST_PASS:'0',
        BBLITE_SCREENSHOT:stem+'.png',BBLITE_RENDER_CAPTURE:stem+'.json',BBLITE_BUILD_STAMP_OUT:stem+'.build-stamp',BBLITE_SCREENSHOT_FRAME:'240',BBLITE_MAX_FRAMES:'241',
        BBLITE_INPUT_REPLAY:replay,BBLITE_CAPTURE_UI:phase.full?'1':'0',BBLITE_RUNTIME_TRACE:'1',BBLITE_GPU_DEBUG:'1',SDL_ASSERT:'always_ignore'},[],true,60000);
    writeFileSync(stem+'.log',log);assert(!/validation error|gpu error|exception/i.test(log),log);verifyBuildIdentity(executable,generated,stem+'.build-stamp');
    const capture=JSON.parse(readFileSync(stem+'.json','utf8')),gpu=capture.textGpu,draw=gpu.draws[0],actual=[];
    assert.deepEqual(capture.viewport,phase.state.viewport);
    if(draw){
        assert.equal(draw.samples,1);assert.equal(draw.depthFormat,'');
        const bytes=Buffer.from(gpu.resources.find(r=>r.id===draw.instances).uploadedBytes);
        for(let i=0;i<draw.instanceCount;i++){const slot=draw.firstInstance+i,word=bytes.readUInt32LE(slot*12+8);if(word!==0xffffffff)actual.push([ids.get(word&0xffff),bytes.readFloatLE(slot*12),bytes.readFloatLE(slot*12+4),word>>>16]);}
        const palette=Buffer.from(gpu.resources.find(r=>r.role==='styles'&&!r.destroyed).uploadedBytes);
        assert.deepEqual(Array.from({length:phase.state.styles.length},(_,i)=>palette.readFloatLE(i*4)),phase.state.styles,`${backend}/${phase.name} style palette`);
        const uniformId=draw.bindings.find(binding=>binding.role==='uniform').resource;
        assert.deepEqual(gpu.resources.find(r=>r.id===uniformId).uploadedBytes,phase.state.uniform,`${backend}/${phase.name} source uniform writes`);
    }
    assert.deepEqual(actual,phase.state.instances.filter(Boolean),`${backend}/${phase.name} source glyph placement`);
    const reference=join(output,`browser-${phase.name}.png`),full=compareImages(stem+'.png',reference),foreground=compareRegion(stem+'.png',reference,[13,15,23],30);
    assert(full.mad<.5&&foreground.mad<.5,`${backend}/${phase.name}: full ${full.mad}, foreground ${foreground.mad}`);
    summaries.push({backend,phase:phase.name,fullMad:full.mad,foregroundMad:foreground.mad});
}
writeFileSync(join(output,'report.json'),JSON.stringify({sourceSha256:hash(readFileSync(sourcePath)),canonicalModuleSha256:hash(canonical),observedModuleSha256:hash(observed),captures:summaries},null,2)+'\n');
console.log(`scene180: ${summaries.length} backend/control captures passed; source glyphs, palette, uniform bytes and images agree.`);
