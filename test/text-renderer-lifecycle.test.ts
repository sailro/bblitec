import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import ts from "typescript";
import {LoweringContext} from "../src/lowering/context.js";
import {TextGpuLowerer} from "../src/lowering/text-gpu-lowerer.js";
import {TextLowerer} from "../src/lowering/text-lowerer.js";
import {TextRendererLowerer} from "../src/lowering/text-renderer-lowerer.js";
import {optionalNativeFixtureTools,runNativeFixtureCompiler} from "./native-fixture.js";

test("standalone text source and native agree on affine uploads, layer order, shared data and bundle invalidation",t=>{
    const native=optionalNativeFixtureTools(false);if(!native){t.skip("Native fixture compiler unavailable.");return;}
    const c=new LoweringContext(),directory=resolve("artifacts/test-text-renderer-lifecycle");
    mkdirSync(resolve(directory,"bblite"),{recursive:true});
    const headers:{[key:string]:string}={upstream_text:new TextLowerer(c).header(),upstream_text_gpu:new TextGpuLowerer(c).header(),upstream_text_renderer:new TextRendererLowerer(c).header()};
    for(const [name,text]of Object.entries(headers)){writeFileSync(resolve(directory,`${name}.hpp`),`#include <bblite/${name}.hpp>`);writeFileSync(resolve(directory,"bblite",`${name}.hpp`),text);}
    const module=(path:string,names:string[])=>names.map(name=>c.functionDeclaration(path,name).declaration.getText().replace(/^export\s+/,"")).join("\n");
    const constants=(path:string,name:string)=>{const f=c.sourceFile(path);return c.numericValue(c.variableInitializer(f,name),f);};
    const source=ts.transpileModule([
        module("src/text/_gpu/text-style-gpu.ts",["createStyleBuffer","ensureStyleGpu"]),
        module("src/text/_gpu/text-textures.ts",["nextPow2Rows","rowsForTexels","createMetaBuffer","createAtlasTexture","uploadAll","ensureSharedAtlasGpu"]),
        module("src/text/text-renderer.ts",["createTextLayer","buildLayerMvp","ensureLayerGpu","ensureInstanceCapacity","uploadLayer","compareLayers","createTextRenderer","textRendererUpdate","textRendererRecord"]),
        "const _mvpScratch=new Float32Array(16);return {createTextLayer,createTextRenderer};",
    ].join("\n"),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
    const events:string[]=[],writes:Buffer[]=[];
    const event=(...values:unknown[])=>events.push(values.join(" ")+" ");
    let next=1;
    interface Resource{id:number;label:string;size:number;destroy():void;createView():Resource}
    const resource=(label:string,size:number):Resource=>{const id=next++;event("create",label,id,size);return{id,label,size,destroy(){event("destroy",id);},createView(){return this;}};};
    const write=(r:Resource,offset:number,buffer:ArrayBuffer,begin:number,count:number)=>{event("write",r.id,offset,count);writes.push(Buffer.from(buffer.slice(begin,begin+count)));};
    const drawCommands=()=>{const commands:unknown[][]=[];return{setPipeline:(p:{id:number})=>commands.push(["pipeline",p.id]),setVertexBuffer:(slot:number,p:{id:number})=>commands.push(["vertex",slot,p.id]),
        setBindGroup:(slot:number,p:{id:number})=>{assert.equal(slot,0);commands.push(["bind",p.id]);},draw:(...args:number[])=>commands.push(["draw",...args]),finish:()=>commands};};
    let bundles=0;
    const device={createBuffer:({label,size}:{label:string;size:number})=>resource(label==="text-layer-ubo"?"text-renderable-ubo":label==="text-layer-instances"?"text-instance":label,size),
        createTexture:({label,size}:{label:string;size:{width:number;height:number}})=>resource(label,size.width*size.height*16),
        createBindGroup:({layout,entries}:{layout:{id:number};entries:Array<{resource:Resource|{buffer:Resource}}>})=>{const g={id:next++};event("group",g.id,layout.id,...entries.map(({resource:r})=>"buffer"in r?r.buffer.id:r.id));return g;},
        queue:{writeBuffer:write,writeTexture:({texture}:{texture:Resource},buffer:ArrayBuffer,options:{offset:number;bytesPerRow:number},size:{height:number})=>write(texture,0,buffer,options.offset,options.bytesPerRow*size.height)},
        createRenderBundleEncoder:(descriptor:{sampleCount:number;colorFormats:string[]})=>{assert.deepEqual(descriptor,{colorFormats:["bgra8unorm"],sampleCount:1});bundles++;return drawCommands();}};
    const engine={_device:device,_currentEncoder:{beginRenderPass:({colorAttachments:[color]}:{colorAttachments:[{loadOp:string;storeOp:string;clearValue:{r:number;g:number;b:number;a:number}}]})=>{
        assert.equal(color.storeOp,"store");event("pass",+(color.loadOp==="clear"),...Object.values(color.clearValue));
        return{executeBundles:(bundles:unknown[][][])=>bundles.forEach(b=>b.forEach(e=>event(...e))),end:()=>event("end")};
    }}};
    const pipelines={_pipeline:{id:1001},_variantPipeline:{id:1002},_cache:{_bindGroupLayout:{id:1003},_quadVertexBuffer:{id:1004}}};
    const instantiate=new Function("GPUBufferUsage","GPUTextureUsage","TEXT_INSTANCE_BYTES","TEXT_STYLE_BYTES","TEXT_UBO_BYTES","GLYPH_METADATA_BYTES","TEX_WIDTH","BYTES_PER_ROW","createEmptyUniformBuffer","getOrCreateTextPipeline","getTextPipelineCache","KIND",source);
    // This fixture executes pinned declarations directly; these types describe
    // the state observed at the native carrier boundary.
    interface Layer{data:typeof data;positionPx:{x:number;y:number};rotationRad:number;scale:number;opacity:number;coverageGamma:number;order:number;visible:boolean}
    interface Gpu{_instanceCap:number;_uploadedDataVersion:number;_uploadedStyleVersion:number;_uploadedViewportW:number;_uploadedViewportH:number;_bundleLayoutVersion:number;_bundleDrawCalls:number;_bindGroupCache:unknown[]}
    interface Renderer{_update():void;_record():number;_layers:Layer[];_layerGpu:Map<Layer,Gpu>;_disposed:boolean}
    const api:{createTextLayer(input:typeof data):Layer;createTextRenderer(surface:unknown,options:unknown):Renderer}=instantiate(
        {STORAGE:1,COPY_DST:2,VERTEX:4},{TEXTURE_BINDING:1,COPY_DST:2,COPY_SRC:4},constants("src/text/text-data.ts","TEXT_INSTANCE_BYTES"),constants("src/text/text-data.ts","TEXT_STYLE_BYTES"),
        constants("src/text/text-renderer.ts","TEXT_UBO_BYTES"),constants("src/text/glyph-storage.ts","GLYPH_METADATA_FLOATS")*4,constants("src/text/_gpu/text-textures.ts","TEX_WIDTH"),constants("src/text/_gpu/text-textures.ts","BYTES_PER_ROW"),
        (e:typeof engine,size:number,label:string)=>e._device.createBuffer({label,size}),(...args:unknown[])=>{assert.deepEqual(args,[engine,"bgra8unorm",1,null,false]);return pipelines;},()=>pipelines._cache,"text-renderer");
    const pattern=(count:number,seed:number)=>new Float32Array(Uint8Array.from({length:count},(_,i)=>(i*37+seed)&255).buffer);
    const atlas={_curveTexData:pattern(131072,3),_bandTexData:pattern(131072,4),_metaData:pattern(384,5),_curveTexelsUsed:3,_bandTexelsUsed:7,_slotCount:3,_version:1,_gpu:null};
    const group=(key:string,start:number,count:number)=>({_curveSet:{_atlas:atlas},_curveSetId:"atlas",_groupKey:key,_slotStart:start,_slotCount:count,_liveCount:2});
    const data={_instances:pattern(192,1),_styles:pattern(128,2),_instanceCount:5,_styleCount:1,_version:1,_styleVersion:1,_layoutVersion:0,_dirtyStart:0,_dirtyEnd:0,_groups:[group("atlas",0,3),group("variant",3,2),group("atlas",0,0)]};
    const a=api.createTextLayer(data),b=api.createTextLayer(data);a.positionPx={x:10,y:20};a.order=2;b.positionPx={x:250,y:50};b.scale=.75;b.order=1;
    const canvas={width:1280,height:720},rr=api.createTextRenderer({engine,canvas,format:"bgra8unorm",scRT:{_colorView:{}}},{layers:[a,b],clearValue:{r:.1,g:.2,b:.3,a:1}});
    const update=()=>rr._update(),draw=()=>event("draws",rr._record());
    const record=()=>rr._layers.forEach(l=>{const g=rr._layerGpu.get(l)!;event("state",l===a?"a":"b",g._instanceCap,g._uploadedDataVersion,g._uploadedStyleVersion,g._uploadedViewportW,g._uploadedViewportH,g._bundleLayoutVersion,g._bundleDrawCalls,g._bindGroupCache.length);});
    const actions:string[]=[];
    const act=(cpp:string,run:()=>void)=>{actions.push(cpp);run();};
    act("update();draw();record();",()=>{update();draw();record();});assert.equal(bundles,2);
    act("update();draw();record();",()=>{update();draw();record();});assert.equal(bundles,2,"steady state reuses bundles");
    act("a->position_px={17.125,-21};a->rotation_rad=std::numbers::pi/7;a->scale=1.25;a->opacity=.7;a->coverage_gamma=2.2;update();draw();record();",()=>{a.positionPx={x:17.125,y:-21};a.rotationRad=Math.PI/7;a.scale=1.25;a.opacity=.7;a.coverageGamma=2.2;update();draw();record();});assert.equal(bundles,2,"uniform edits preserve bundles");
    act("width=960;height=600;a->opacity=.5;update();draw();record();",()=>{canvas.width=960;canvas.height=600;a.opacity=.5;update();draw();record();});
    act("a->visible=false;data->version=2;data->dirty_start=1;data->dirty_end=2;update();draw();record();",()=>{a.visible=false;data._version=2;data._dirtyStart=1;data._dirtyEnd=2;update();draw();record();});
    act("a->visible=true;a->order=0;update();draw();record();",()=>{a.visible=true;a.order=0;update();draw();record();});
    act("data->layout_version=1;data->groups[0].slot_count=2;update();draw();record();",()=>{data._layoutVersion=1;data._groups[0]!._slotCount=2;update();draw();record();});assert.equal(bundles,4);
    act("data->instance_count=9;data->version=3;data->style_count=3;data->style_version=2;payload->atlases[0].curves.used_texels=4097;payload->atlases[0].version=2;update();draw();record();",()=>{data._instanceCount=9;data._version=3;data._styleCount=3;data._styleVersion=2;atlas._curveTexelsUsed=4097;atlas._version=2;update();draw();record();});assert.equal(bundles,6);
    act("ops.pipelines.pipeline=named(1005);update();draw();record();",()=>{pipelines._pipeline={id:1005};update();draw();record();});assert.equal(bundles,8);
    act("data->groups.pop_back();update();draw();record();",()=>{data._groups.pop();update();draw();record();});assert.equal(bundles,10);
    act("data->instance_count=0;update();draw();record();",()=>{data._instanceCount=0;update();draw();record();});
    act("rr.disposed=true;update();draw();",()=>{rr._disposed=true;update();draw();});
    writeFileSync(resolve(directory,"actions.hpp"),actions.join("\n"));
    const exe=resolve(directory,"check.exe");
    runNativeFixtureCompiler(native,["/nologo","/std:c++20","/EHsc","/W4","/WX","/fp:strict",`/I${directory}`,`/I${resolve("native/include")}`,resolve("test/fixtures/text-renderer-lifecycle-check.cpp"),`/Fo${resolve(directory,"check.obj")}`,`/Fe${exe}`]);
    execFileSync(exe,[],{cwd:directory,stdio:"pipe"});
    assert.equal(readFileSync(resolve(directory,"events.txt"),"utf8").replaceAll("\r\n","\n"),events.join("\n")+"\n");
    assert.deepEqual(readFileSync(resolve(directory,"writes.bin")),Buffer.concat(writes));
});
