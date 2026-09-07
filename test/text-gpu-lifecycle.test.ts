import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { LoweringContext } from "../src/lowering/context.js";
import { TextGpuLowerer } from "../src/lowering/text-gpu-lowerer.js";
import { TextLowerer } from "../src/lowering/text-lowerer.js";
import { PinnedNumericLowerer, type PinnedNumericScope } from "../src/lowering/pinned-numeric-lowerer.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

// Real pinned function bodies with only device resources and pipeline resolution
// replaced by recorders. No fixture reimplementation of resource state decisions.
function pinnedFunctions(context: LoweringContext): string {
    const module=(path:string,names:string[])=>names.map(name=>context.functionDeclaration(path,name).declaration.getText().replace(/^export\s+/,"")).join("\n");
    const renderable="src/text/text-renderable.ts";
    const update=context.functionDeclaration(renderable,"updateTextRenderable").declaration;
    const body=update.body!.statements;
    const end=body.findIndex(s=>ts.isVariableStatement(s)&&s.declarationList.declarations[0]?.name.getText()==="camera");
    assert.ok(end>0);
    return ts.transpileModule([
        module("src/text/_gpu/text-style-gpu.ts",["createStyleBuffer","ensureStyleGpu"]),
        module("src/text/_gpu/text-textures.ts",["nextPow2Rows","rowsForTexels","createMetaBuffer","createAtlasTexture","uploadAll","ensureSharedAtlasGpu"]),
        module(renderable,["targetSig","ensureGpu","ensureInstanceCapacity","drawTextRenderable"]),
        `function updateResources(r,engine,gpu,bindGroupLayout){${body.slice(0,end).map(s=>s.getText()).join("\n")}}`,
        "return {ensureGpu,updateResources,drawTextRenderable,targetSig};",
    ].join("\n"),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
}

function statementProbe(source:string,adapt=true):string {
    const file=ts.createSourceFile("statement-probe.ts",source,ts.ScriptTarget.Latest,true);
    const statement:NonNullable<PinnedNumericScope["statement"]>=(node,lowerer,indent)=>{
        if(!ts.isExpressionStatement(node)||!ts.isCallExpression(node.expression)||node.expression.expression.getText()!=="retain")return undefined;
        if(node.expression.arguments.length!==1)throw new Error("Unrepresented retained statement shape.");
        return [`${indent}ops.event("hook", ${lowerer.expression(node.expression.arguments[0]!)});`];
    };
    const lowerer=new PinnedNumericLowerer(file,{bindings:new Map(),calls:new Map(),...(adapt?{statement}:{})});
    return lowerer.statements(file.statements,"    ").join("\n");
}

test("text GPU helpers preserve pinned identities, byte uploads, growth, failures and draw order",async t=>{
    const native=optionalNativeFixtureTools(false);
    if(!native){t.skip("Native fixture compiler unavailable.");return;}
    const context=new LoweringContext(),directory=resolve("artifacts/test-text-gpu-lifecycle");
    mkdirSync(directory,{recursive:true});
    writeFileSync(resolve(directory,"upstream_text.hpp"),new TextLowerer(context).header());
    writeFileSync(resolve(directory,"upstream_text_gpu.hpp"),new TextGpuLowerer(context).header());
    const probe="let total=0;for(let i=0;i<4;i++){if(i===1)continue;retain(i);total+=i;}retain(total);";
    writeFileSync(resolve(directory,"statement-probe.hpp"),`void statement_probe(Ops& ops){\n${statementProbe(probe)}\n}`);
    const events:string[]=[],writes:Buffer[]=[];
    const event=(...values:unknown[])=>events.push(values.join(" ")+" ");
    let next=1,fail="";
    const failure=(operation:string)=>{if(fail===operation){fail="";event("fail",operation);throw new Error(operation);}};
    interface Resource {id:number;label:string;size:number;destroy():void;createView():Resource}
    const resource=(label:string,size:number):Resource=>{
        failure("create:"+label);const id=next++;event("create",label,id,size);
        return {id,label,size,destroy(){event("destroy",id);},createView(){return this;}};
    };
    const write=(target:Resource,offset:number,buffer:ArrayBuffer,begin:number,count:number)=>{
        failure("write:"+target.label);event("write",target.id,offset,count);writes.push(Buffer.from(buffer.slice(begin,begin+count)));
    };
    const makeDevice=()=>({createBuffer:({label,size}:{label:string;size:number})=>resource(label,size),
        createTexture:({label,size}:{label:string;size:{width:number;height:number}})=>resource(label,size.width*size.height*16),
        createBindGroup:({layout,entries}:{layout:{id:number};entries:Array<{resource:Resource|{buffer:Resource}}>})=>{
            failure("group");const group={id:next++};event("group",group.id,layout.id,...entries.map(({resource:r})=>"buffer"in r?r.buffer.id:r.id));return group;
        },queue:{writeBuffer:write,writeTexture:({texture}:{texture:Resource},buffer:ArrayBuffer,
            options:{offset:number;bytesPerRow:number},size:{height:number})=>write(texture,0,buffer,options.offset,options.bytesPerRow*size.height)}});
    const deviceA=makeDevice(),deviceB=makeDevice(),engine={_device:deviceA};
    const pattern=(count:number,seed:number)=>new Float32Array(Uint8Array.from({length:count},(_,i)=>(i*37+seed)&255).buffer);
    const atlas={_curveTexData:pattern(131072,3),_bandTexData:pattern(131072,4),_metaData:pattern(384,5),
        _curveTexelsUsed:3,_bandTexelsUsed:7,_slotCount:3,_version:1,_gpu:null as any};
    const group=(key:string,start:number,count:number)=>({_curveSet:{_atlas:atlas},_curveSetId:"atlas",_groupKey:key,
        _slotStart:start,_slotCount:count,_liveCount:2,_bindGroup:null as any,_bindGroupVersion:-1});
    const data={_instances:pattern(192,1),_styles:pattern(128,2),_instanceCount:3,_styleCount:1,_version:1,_styleVersion:1,
        _dirtyStart:0,_dirtyEnd:0,_groups:[group("atlas",0,3),group("variant",3,2),group("atlas",0,0)]};
    const r={_data:data,_gpu:null as any},second={_data:data,_gpu:null as any};
    const pipelines={_pipeline:{id:1001},_variantPipeline:{id:1002}},layout={id:1003},quad={id:1004};
    const target={_colorFormat:"rgba8unorm",_sampleCount:4,_depthStencilFormat:"depth24plus"};
    const constants=(path:string,name:string)=>{const f=context.sourceFile(path);return context.numericValue(context.variableInitializer(f,name),f);};
    const instantiate=new Function("GPUBufferUsage","GPUTextureUsage","TEXT_INSTANCE_BYTES","TEXT_STYLE_BYTES","TEXT_UBO_BYTES",
        "GLYPH_METADATA_BYTES","TEX_WIDTH","BYTES_PER_ROW","createEmptyUniformBuffer","getOrCreateTextPipeline",pinnedFunctions(context));
    const pin=instantiate({STORAGE:1,COPY_DST:2,VERTEX:4},{TEXTURE_BINDING:1,COPY_DST:2,COPY_SRC:4},
        constants("src/text/text-data.ts","TEXT_INSTANCE_BYTES"),constants("src/text/text-data.ts","TEXT_STYLE_BYTES"),
        constants("src/text/text-renderable.ts","TEXT_UBO_BYTES"),constants("src/text/glyph-storage.ts","GLYPH_METADATA_FLOATS")*4,
        constants("src/text/_gpu/text-textures.ts","TEX_WIDTH"),constants("src/text/_gpu/text-textures.ts","BYTES_PER_ROW"),
        (e:typeof engine,size:number,label:string)=>e._device.createBuffer({label,size}),()=>pipelines);
    let gpu:any;
    const ensure=()=>gpu=pin.ensureGpu(r,engine,target,target._colorFormat,4,target._depthStencilFormat,true);
    const update=()=>pin.updateResources(r,engine,gpu,layout);
    const pass={setVertexBuffer:(slot:number,buffer:{id:number})=>event("vertex",slot,buffer.id),
        setPipeline:(p:{id:number})=>event("pipeline",p.id),setBindGroup:(slot:number,g:{id:number})=>{assert.equal(slot,0);event("bind",g.id);},
        draw:(...values:number[])=>event("draw",...values)};
    const draw=()=>event("draws",pin.drawTextRenderable(gpu,data,quad,pass));
    const record=()=>event("state",gpu._instanceCap,gpu._styleBuf.size,gpu._uploadedDataVersion,gpu._uploadedStyleVersion,
        data._dirtyStart,data._dirtyEnd,atlas._gpu._curveTexRows,atlas._gpu._bandTexRows,atlas._gpu._metaCap,atlas._gpu._uploadedVersion,
        data._groups[0]!._bindGroup?.id??0,data._groups[0]!._bindGroupVersion);
    const actions:string[]=[];
    const act=(cpp:string,run:()=>void)=>{actions.push(cpp);run();};
    act("statement_probe(ops);",()=>new Function("retain",probe)((value:number)=>event("hook",value)));
    const alpha=await importPinnedModule<{setAlphaToCoverage(target:object,enabled:boolean):void;getAlphaToCoverage(target:object):boolean}>("render/alpha-to-coverage.js");
    act("ops.event(\"alpha\",int(get_text_alpha_to_coverage(*r)),int(get_text_alpha_to_coverage(*second)));",()=>event("alpha",+alpha.getAlphaToCoverage(r),+alpha.getAlphaToCoverage(second)));
    act("set_text_alpha_to_coverage(*r,true);set_text_alpha_to_coverage(*r,true);ops.event(\"alpha\",int(get_text_alpha_to_coverage(*r)),int(get_text_alpha_to_coverage(*second)));",()=>{
        alpha.setAlphaToCoverage(r,true);alpha.setAlphaToCoverage(r,true);event("alpha",+alpha.getAlphaToCoverage(r),+alpha.getAlphaToCoverage(second));
    });
    act("set_text_alpha_to_coverage(*r,false);ops.event(\"alpha\",int(get_text_alpha_to_coverage(*r)));",()=>{alpha.setAlphaToCoverage(r,false);event("alpha",+alpha.getAlphaToCoverage(r));});
    act("ensure();update();draw();record();",()=>{ensure();update();draw();record();});
    const firstWriteCount=writes.length;
    act("ensure();update();draw();record();",()=>{ensure();update();draw();record();});
    assert.equal(writes.length,firstWriteCount,"steady state has no uploads");
    const originalGroup=data._groups[0]!._bindGroup;
    act("auto second_gpu=ensure_text_gpu(*second,device,target,pipelines,ops);update_text_resources(*second,*second_gpu,pipelines.layout,ops);record();",()=>{
        const other=pin.ensureGpu(second,engine,target,target._colorFormat,4,target._depthStencilFormat,true);
        pin.updateResources(second,engine,other,layout);record();
    });
    assert.equal(data._groups[0]!._bindGroup,originalGroup,"shared data retains original group resource identities");
    act("pipelines.pipeline=named(1005);ensure();update();draw();record();",()=>{pipelines._pipeline={id:1005};ensure();update();draw();record();});
    act("data->version=2;data->dirty_start=1;data->dirty_end=2;update();record();",()=>{data._version=2;data._dirtyStart=1;data._dirtyEnd=2;update();record();});
    act('data->version=3;data->dirty_start=1;data->dirty_end=3;ops.fail="write:text-instance";try{update();return 11;}catch(const std::runtime_error&){}record();',()=>{
        data._version=3;data._dirtyStart=1;data._dirtyEnd=3;fail="write:text-instance";assert.throws(update,/write:text-instance/);record();
    });
    assert.equal(gpu._uploadedDataVersion,2);assert.equal(data._dirtyEnd,3);
    act("update();record();",()=>{update();record();});
    act("data->instance_count=9;data->version=4;data->style_count=3;data->style_version=2;payload->atlases[0].curves.used_texels=4097;payload->atlases[0].bands.used_texels=4098;payload->atlases[0].metadata.count=6;payload->atlases[0].version=2;update();record();",()=>{
        data._instanceCount=9;data._version=4;data._styleCount=3;data._styleVersion=2;atlas._curveTexelsUsed=4097;atlas._bandTexelsUsed=4098;atlas._slotCount=6;atlas._version=2;update();record();
    });
    const oldGpu=r._gpu;
    act('device=&device_b;ops.fail="create:text-instance";try{ensure();return 12;}catch(const std::runtime_error&){}if(r->gpu!=gpu)return 13;record();',()=>{
        engine._device=deviceB;fail="create:text-instance";assert.throws(ensure,/create:text-instance/);assert.equal(r._gpu,oldGpu);record();
    });
    act("ensure();update();record();",()=>{ensure();update();record();});
    act("data->instance_count=0;data->version=5;update();draw();record();",()=>{data._instanceCount=0;data._version=5;update();draw();record();});
    act("ops.event(text_target_key({}));",()=>event(pin.targetSig({})));
    writeFileSync(resolve(directory,"actions.hpp"),actions.join("\n"));
    const exe=resolve(directory,"check.exe");
    runNativeFixtureCompiler(native,["/nologo","/std:c++20","/EHsc","/W4","/WX",`/I${resolve("native/include")}`,`/I${directory}`,
        resolve("test/fixtures/text-gpu-lifecycle-check.cpp"),`/Fo${resolve(directory,"check.obj")}`,`/Fe${exe}`]);
    execFileSync(exe,[],{cwd:directory,stdio:"pipe"});
    assert.equal(readFileSync(resolve(directory,"events.txt"),"utf8").replaceAll("\r\n","\n"),events.join("\n")+"\n");
    assert.deepEqual(readFileSync(resolve(directory,"writes.bin")),Buffer.concat(writes));
});

test("resource adapters refuse changed device shapes and leave unknown statements to the shared lowerer",()=>{
    assert.throws(()=>statementProbe("retain(1);",false),/Unsupported pinned call 'retain'/);
    assert.throws(()=>statementProbe("retain(1,2);"),/Unrepresented retained statement shape/);
    assert.throws(()=>statementProbe("unknownOperation(1);"),/Unsupported pinned call 'unknownOperation'/);
    class ChangedContext extends LoweringContext {
        private changed:ts.SourceFile|undefined;
        constructor(private readonly path:string,private readonly before:string,private readonly after:string){super();}
        override sourceFile(path:string):ts.SourceFile {
            const source=super.sourceFile(path);
            if(path!==this.path)return source;
            assert.ok(source.text.includes(this.before),this.before);
            return this.changed??=ts.createSourceFile(path,source.text.replace(this.before,this.after),ts.ScriptTarget.Latest,true);
        }
    }
    const module="src/text/text-renderable.ts";
    for(const [path,before,after,reason] of [
        [module,"const data = r._data;","const data = r._data, extra = sideEffect();",/additional bindings/],
        [module,"ensureStyleGpu(device, data, gpu)","ensureStyleGpu(device, r._data, gpu)",/style synchronization inputs/],
        [module,"{ binding: 4, resource: { buffer: gpu._styleBuf } }","{ binding: 4, resource: { buffer: gpu._instanceBuf } }",/resource identities and binding order/],
        [module,"pass.draw(6, g._slotCount, 0, g._slotStart)","pass.draw(6, g._liveCount, 0, g._slotStart)",/instanced draw ranges/],
        ["src/text/_gpu/text-textures.ts",'format: "rgba32float"','format: "rgba16float"',/atlas texture descriptor/],
    ] as const) assert.throws(()=>new TextGpuLowerer(new ChangedContext(path,before,after)).header(),reason);
    assert.throws(()=>new TextLowerer(new ChangedContext("src/render/alpha-to-coverage.ts","_enabledTargets.add(target)","_enabledTargets.delete(target)")).header(),/enabled membership/);
    const changed=new TextGpuLowerer(new ChangedContext(module,"cap *= 2;","cap *= 3;")).header();
    assert.match(changed,/cap \*= 3\.0;/,"numeric growth continues to come from source rather than an asserted formula");
});
