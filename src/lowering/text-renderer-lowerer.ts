import ts from "typescript";
import { LoweringContext } from "./context.js";
import { PinnedNumericLowerer, type PinnedBinding, type PinnedNumericScope } from "./pinned-numeric-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";

const module = "src/text/text-renderer.ts";
const scalar = (cpp: string): PinnedBinding => ({cpp,type:"scalar"});
const opaque = (cpp: string): PinnedBinding => ({cpp,type:"opaque"});

/** Standalone text placement and per-layer GPU state from the pinned renderer. */
export class TextRendererLowerer {
    constructor(private readonly context: LoweringContext) {}

    private layerBindings(root = "layer", native = "layer."): Map<string,PinnedBinding> {
        return new Map([
            [`${root}.positionPx.x`,scalar(`${native}position_px.x`)],
            [`${root}.positionPx.y`,scalar(`${native}position_px.y`)],
            ...["rotationRad","scale","order","opacity","coverageGamma"].map(name =>
                [`${root}.${name}`,scalar(native + ({rotationRad:"rotation_rad",coverageGamma:"coverage_gamma"}[name] ?? name))] as const),
            [`${root}.visible`,{cpp:`${native}visible`,type:"bool"}],
        ]);
    }

    private matrix(): string {
        const {file,declaration}=this.context.functionDeclaration(module,"buildLayerMvp");
        const lowerer=new PinnedNumericLowerer(file,{bindings:new Map([
            ...this.layerBindings(),["targetW",scalar("width")],["targetH",scalar("height")],
            ["out",{cpp:"out",type:"f32",mutable:true}],
        ]),calls:new Map([...pinnedNumericMathCalls(),["out.fill",args=>`out.fill(static_cast<float>(${args[0]}))`]])});
        return `// ${this.context.provenance(module,"buildLayerMvp")}
inline void build_text_layer_mvp(const TextLayerState& layer, double width, double height, std::array<float,16>& out) {
${lowerer.statements(declaration.body!.statements,"    ").join("\n")}
}`;
    }

    private gpuBindings(root="lg",native="gpu."): Map<string,PinnedBinding> {
        return new Map([
            ...["instanceCap","uploadedDataVersion","uploadedStyleVersion","uploadedViewportW","uploadedViewportH","bundleLayoutVersion","bundleDrawCalls"].map(name =>
                [`${root}._${name}`,scalar(native + ({instanceCap:"instance_capacity",uploadedDataVersion:"uploaded_data_version",uploadedStyleVersion:"uploaded_style_version",uploadedViewportW:"uploaded_viewport_w",uploadedViewportH:"uploaded_viewport_h",bundleLayoutVersion:"bundle_layout_version",bundleDrawCalls:"bundle_draw_calls"}[name]))] as const),
            [`${root}._pipeline`,opaque(`${native}pipeline`)],[`${root}._variantPipeline`,opaque(`${native}variant_pipeline`)],
            [`${root}._renderBundle`,{...opaque(`${native}render_bundle`),absentCpp:`!${native}render_bundle`}],
        ]);
    }

    private factories(): string {
        const c:LoweringContext=this.context;
        c.assertFunctionBodyShape(c.functionDeclaration(module,"createTextLayer").declaration,`{return {
            _kind:"text-layer",data,positionPx:{x:options?.positionPx?.x??0,y:options?.positionPx?.y??0},
            rotationRad:options?.rotationRad??0,scale:options?.scale??1,order:options?.order??0,
            opacity:options?.opacity??1,coverageGamma:options?.coverageGamma??1,visible:options?.visible??true,_version:0
        };}`,"Text layer native option defaults");
        c.assertFunctionBodyShape(c.functionDeclaration(module,"createTextRenderer").declaration,`{
            const canvas=surface.canvas;
            const layers=opts.layers.slice();
            const rr: TextRenderer={_kind:KIND,_surface:surface,_layerGpu:new Map(),_targetWidth:canvas.width,_targetHeight:canvas.height,
                _disposed:false,_clear:opts.clear??true,_visibleBundles:[],layers,_layers:layers,
                clearColor:opts.clearValue??{r:0,g:0,b:0,a:1},_drawCallsPre:0,
                _update():void{textRendererUpdate(rr);},_record():number{return textRendererRecord(rr);}};
            return rr;}`,"Text renderer surface and layer ownership");
        c.assertFunctionBodyShape(c.functionDeclaration(module,"registerTextRenderer").declaration,
            "{registerRenderingContext(tr._surface,tr);}","Text renderer context registration");
        const position=c.functionDeclaration(module,"setTextLayerPosition");
        const lowerer=new PinnedNumericLowerer(position.file,{bindings:new Map([...this.layerBindings(),
            ["layer._version",scalar("layer.version")],["x",scalar("x")],["y",scalar("y")]]),calls:new Map()});
        return `inline TextLayer create_text_layer(TextData data,const TextLayerOptions& options={}) {
    auto layer=std::make_shared<TextLayerState>();
    static_cast<TextLayerOptions&>(*layer)=options;layer->data=std::move(data);return layer;
}
inline void text_write_position_px(TextLayerState& layer,int axis,double value) {
    if(axis==0)layer.position_px.x=value;
    else if(axis==1)layer.position_px.y=value;
    else throw std::out_of_range("Text layer position component");
}
inline void set_text_layer_position(TextLayerState& layer,double x,double y) {
${lowerer.statements(position.declaration.body!.statements,"    ").join("\n")}
}
inline TextRenderer create_text_renderer(Engine& engine,const TextRendererOptions& options) {
    auto renderer=std::make_shared<TextRendererState>();renderer->engine=&engine;
    renderer->layers=options.layers;renderer->clear=options.clear;renderer->clear_value=options.clear_value;
    renderer->target_width=engine.options.width;renderer->target_height=engine.options.height;return renderer;
}
inline void register_text_renderer(const TextRenderer& renderer) {
    auto& registered=renderer->engine->registered_text_renderers;
    if(std::find(registered.begin(),registered.end(),renderer)==registered.end())registered.push_back(renderer);
}
inline std::shared_ptr<TextLayerGpuState> find_text_layer_gpu(const TextRendererState& renderer,const TextLayer& layer) {
    const auto found=renderer.layer_gpu.find(layer);return found==renderer.layer_gpu.end()?nullptr:found->second;
}`;
    }

    private ensureGpu(): string {
        const c:LoweringContext=this.context;
        const {file,declaration}=c.functionDeclaration(module,"ensureLayerGpu");
        const dataFile=c.sourceFile("src/text/text-data.ts");
        const constants=new Map<string,PinnedBinding>([
            ["TEXT_UBO_BYTES",scalar(String(c.numericValue(c.variableInitializer(file,"TEXT_UBO_BYTES"),file)))],
            ["TEXT_INSTANCE_BYTES",scalar(String(c.numericValue(c.variableInitializer(dataFile,"TEXT_INSTANCE_BYTES"),dataFile)))],
        ]);
        const fields:Record<string,string>={_uploadedStyleVersion:"uploaded_style_version",_instanceCap:"instance_capacity",
            _uploadedDataVersion:"uploaded_data_version",_uploadedViewportW:"uploaded_viewport_w",_uploadedViewportH:"uploaded_viewport_h",
            _mvpUploaded:"mvp_uploaded",_bundleLayoutVersion:"bundle_layout_version",_bundleDrawCalls:"bundle_draw_calls"};
        const bindings=new Map<string,PinnedBinding>([...constants,...this.gpuBindings("lg","lg->"),
            ["lg",{...opaque("lg"),absentCpp:"!lg"}],["layer",opaque("layer")],
            ["layer.data._instanceCount",scalar("static_cast<double>(layer->data->instance_count)")],
        ]);
        const lowerer=new PinnedNumericLowerer(file,{bindings,calls:new Map([...pinnedNumericMathCalls(),
            ["rr._layerGpu.set",()=>"rr.layer_gpu[layer]=lg"]]),returnValue:expression=>expression?lowerer.expression(expression):"",
            statement:(node,lowerer,indent)=>{
                if(ts.isVariableStatement(node) && node.declarationList.declarations.length===1) {
                    const variable=node.declarationList.declarations[0]!;
                    const name=variable.name.getText();
                    const aliases:Record<string,readonly[string,string]>={lg:["rr._layerGpu.get(layer)","auto lg=find_text_layer_gpu(rr,layer);"],
                        engine:["rr._surface.engine",""],device:["engine._device",""]};
                    const alias=aliases[name];
                    if(alias){c.assertExpressionShape(variable.initializer!,alias[0],`Text layer GPU ${name} identity`);return alias[1]?[`${indent}${alias[1]}`]:[];}
                }
                if(!ts.isExpressionStatement(node) || !ts.isBinaryExpression(node.expression) || !ts.isIdentifier(node.expression.left) || node.expression.left.text!=="lg")return undefined;
                const object=node.expression.right;
                if(node.expression.operatorToken.kind!==ts.SyntaxKind.EqualsToken || !ts.isObjectLiteralExpression(object))c.contractError(object,"Text layer GPU factory assignment changed.");
                const expectedFields=["_layer","_textU","_instanceBuf","_instanceCap","_styleBuf","_uploadedStyleVersion","_pipeline","_variantPipeline","_bindGroupCache","_uploadedDataVersion","_uploadedViewportW","_uploadedViewportH","_lastMvpInputs","_mvpUploaded","_renderBundle","_bundleLayoutVersion","_bundleDrawCalls"];
                if(object.properties.map(property=>property.name?.getText()).join()!==expectedFields.join())c.contractError(object,"Text layer GPU fields or initialization order changed.");
                const lines=[`${indent}lg=std::make_shared<TextLayerGpuState>();`,`${indent}lg->device_identity=device_identity;`];
                for(const property of object.properties) {
                    if(!ts.isPropertyAssignment(property))c.contractError(property,"Text layer GPU descriptor property changed.");
                    const name=property.name.getText(),value=property.initializer;
                    if(fields[name]){lines.push(`${indent}lg->${fields[name]}=${lowerer.expression(value)};`);continue;}
                    if(name==="_layer"){c.assertExpressionShape(value,"layer","Text GPU layer owner");lines.push(`${indent}lg->layer=layer;`);continue;}
                    if(["_pipeline","_variantPipeline","_renderBundle"].includes(name)){
                        c.assertExpressionShape(value,"null","Text layer initial GPU cache");continue;
                    }
                    if(name==="_bindGroupCache"){c.assertExpressionShape(value,"[]","Text layer initial group cache");continue;}
                    if(name==="_lastMvpInputs"){c.assertExpressionShape(value,"new Float32Array(6)","Text layer MVP cache fields");continue;}
                    if(name==="_textU") {
                        c.assertExpressionShape(value,'createEmptyUniformBuffer(engine,TEXT_UBO_BYTES,"text-layer-ubo")',"Text layer uniform allocation");
                        lines.push(`${indent}ops.create_renderable_buffer(*lg,TextBufferKind::uniform,text_resource_size(${constants.get("TEXT_UBO_BYTES")!.cpp}));`);continue;
                    }
                    if(name==="_styleBuf") {
                        c.assertExpressionShape(value,"createStyleBuffer(device,1)","Text layer initial style palette");
                        lines.push(`${indent}create_text_style_buffer(*lg,1,ops);`);continue;
                    }
                    if(name==="_instanceBuf") {
                        c.assertExpressionShape(value,'device.createBuffer({label:"text-layer-instances",size:cap*TEXT_INSTANCE_BYTES,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST})',"Text layer initial instance buffer");
                        if(!ts.isCallExpression(value) || !value.arguments[0] || !ts.isObjectLiteralExpression(value.arguments[0]))c.contractError(value,"Text layer buffer descriptor changed.");
                        lines.push(`${indent}ops.create_renderable_buffer(*lg,TextBufferKind::instances,text_resource_size(${lowerer.expression(c.propertyInitializer(value.arguments[0],"size"))}));`);continue;
                    }
                    c.contractError(property,"Unrepresented text layer GPU field.");
                }
                return lines;
            }});
        return `template<class Ops> std::shared_ptr<TextLayerGpuState> ensure_text_layer_gpu(TextRendererState& rr,const TextLayer& layer,const void* device_identity,Ops& ops) {
${lowerer.statements(declaration.body!.statements,"    ").join("\n")}
}`;
    }

    private capacity(): string {
        const c: LoweringContext=this.context;
        const {file,declaration}=c.functionDeclaration(module,"ensureInstanceCapacity");
        const dataFile=c.sourceFile("src/text/text-data.ts");
        const bindings=new Map([...this.gpuBindings(),["needed",scalar("needed")],
            ["TEXT_INSTANCE_BYTES",scalar(String(c.numericValue(c.variableInitializer(dataFile,"TEXT_INSTANCE_BYTES"),dataFile)))]]);
        const lowerer=new PinnedNumericLowerer(file,{bindings,
            calls:new Map([["lg._instanceBuf.destroy",()=>"if (gpu.destroy_instances) gpu.destroy_instances()"]]),
            statement:(node,lowerer,indent)=>{
                if(!ts.isExpressionStatement(node) || !ts.isBinaryExpression(node.expression))return undefined;
                const assignment=node.expression;
                if(c.propertyPath(assignment.left)?.join(".")==="lg._renderBundle") {
                    c.assertExpressionShape(assignment,"lg._renderBundle = null","Text layer capacity bundle invalidation");
                    return [`${indent}gpu.render_bundle.reset();`];
                }
                if(c.propertyPath(assignment.left)?.join(".")==="lg._instanceBuf") {
                    c.assertExpressionShape(assignment.right,`device.createBuffer({label:"text-layer-instances",size:cap*TEXT_INSTANCE_BYTES,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST})`,"Text layer instance allocation boundary");
                    const descriptor=assignment.right;
                    if(!ts.isCallExpression(descriptor) || !descriptor.arguments[0] || !ts.isObjectLiteralExpression(descriptor.arguments[0]))
                        c.contractError(descriptor,"Text layer instance descriptor changed.");
                    const object=descriptor.arguments[0];
                    return [`${indent}ops.create_renderable_buffer(gpu,TextBufferKind::instances,text_resource_size(${lowerer.expression(c.propertyInitializer(object,"size"))}));`];
                }
                return undefined;
            }});
        return `template<class Ops> void ensure_text_layer_capacity(TextLayerGpuState& gpu,double needed,Ops& ops) {
${lowerer.statements(declaration.body!.statements,"    ").join("\n")}
}`;
    }

    private uniforms(): string {
        const c: LoweringContext=this.context;
        const {file,declaration}=c.functionDeclaration(module,"uploadLayer");
        const statements=declaration.body!.statements;
        const boundary=statements.findIndex(s=>ts.isVariableStatement(s) && s.declarationList.declarations[0]?.name.getText() === "W");
        if(boundary<0)c.contractError(declaration,"Standalone text uniform boundary changed.");
        const bindings = new Map<string,PinnedBinding>([
            ...this.layerBindings(),["layer",opaque("layer")],["rr._targetWidth",scalar("width")],["rr._targetHeight",scalar("height")],
            ["lg._lastMvpInputs",{cpp:"gpu.last_mvp_inputs",type:"f32",mutable:true}],
            ["lg._mvpUploaded",{cpp:"gpu.mvp_uploaded",type:"bool"}],
            ["lg._uploadedViewportW",scalar("gpu.uploaded_viewport_w")],["lg._uploadedViewportH",scalar("gpu.uploaded_viewport_h")],
            ["_mvpScratch",{cpp:"mvp",type:"f32",mutable:true}],
        ]);
        const statement: NonNullable<PinnedNumericScope["statement"]> = (node,lowerer,indent) => {
            if(ts.isVariableStatement(node) && node.declarationList.declarations.length===1) {
                const variable=node.declarationList.declarations[0]!;
                if(variable.initializer && ts.isNewExpression(variable.initializer) &&
                    ts.isIdentifier(variable.initializer.expression) && variable.initializer.expression.text==="Float32Array") {
                    const args=variable.initializer.arguments;
                    if(!ts.isIdentifier(variable.name) || args?.length!==1 || !ts.isArrayLiteralExpression(args[0]!))
                        c.contractError(variable,"Standalone text uniform typed-array literal changed.");
                    const name=variable.name.text, values=args[0]!.elements;
                    if(values.length!==4)c.contractError(variable,"Text viewport/color uniforms require the pinned four-float span.");
                    bindings.set(name,{cpp:name,type:"f32"});
                    return [`${indent}const std::array<float,${values.length}> ${name}{${values.map(value=>`static_cast<float>(${lowerer.expression(value)})`).join(",")}};`];
                }
            }
            if(ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
                const call=node.expression;
                if(c.propertyPath(call.expression)?.join(".")==="device.queue.writeBuffer") {
                    if(call.arguments.length!==5)c.contractError(call,"Standalone text uniform upload arity changed.");
                    c.assertExpressionShape(call.arguments[0]!,"lg._textU","Standalone text uniform owner");
                    const source=c.unwrapExpression(call.arguments[2]!);
                    if(!ts.isPropertyAccessExpression(source) || source.name.text!=="buffer" || !ts.isIdentifier(source.expression))
                        c.contractError(source,"Standalone text uniform source array changed.");
                    const name=source.expression.text;
                    if(!["_mvpScratch","vp","col"].includes(name))c.contractError(source,"Unknown standalone text uniform array.");
                    c.assertExpressionShape(call.arguments[3]!,`${name}.byteOffset`,"Standalone text uniform byte offset");
                    c.assertExpressionShape(call.arguments[4]!,name==="_mvpScratch"?"64":"16","Standalone text uniform byte count");
                    return [`${indent}write(text_resource_size(${lowerer.expression(call.arguments[1]!)}), text_layer_bytes(${name==="_mvpScratch"?"mvp":name}));`];
                }
            }
            return undefined;
        };
        const lowerer=new PinnedNumericLowerer(file,{bindings,statement,booleanAnd:true,booleanOr:true,
            calls:new Map([...pinnedNumericMathCalls(),["buildLayerMvp",args=>`build_text_layer_mvp(${args.join(",")})`]])});
        return `// ${c.provenance(module,"uploadLayer","uniform suffix follows resource synchronization")}
inline void upload_text_layer_uniforms(const TextLayerState& layer, TextLayerGpuState& gpu,
    double width, double height, const TextUniformWrite& write) {
    thread_local std::array<float,16> mvp;
${lowerer.statements(statements.slice(boundary),"    ").join("\n")}
}`;
    }

    private resources(): string {
        const c: LoweringContext=this.context;
        const {file,declaration}=c.functionDeclaration(module,"uploadLayer");
        const statements=declaration.body!.statements;
        const boundary=statements.findIndex(s=>ts.isVariableStatement(s) && s.declarationList.declarations[0]?.name.getText()==="W");
        if(boundary<0)c.contractError(declaration,"Standalone text resource/uniform boundary changed.");
        const dataFile=c.sourceFile("src/text/text-data.ts");
        const bindings=new Map<string,PinnedBinding>([
            ...this.gpuBindings(),["lg",opaque("gpu")],["data",opaque("data")],["device",opaque("gpu.device_identity")],
            ["bindGroupLayout",opaque("layout")],["rebuilt",{cpp:"atlas_result.rebuilt",type:"bool"}],
            ["cached",{...opaque("cached"),absentCpp:"!cached"}],
            ["cached._atlasVersion",scalar("cached->atlas_version")],["cached._curveSetId",opaque("cached->curve_set_id")],
            ["atlasGpu._uploadedVersion",scalar("atlasGpu.uploaded_version")],
            ["g._curveSetId",opaque("data.payload->atlases.at(g.atlas_index).curve_set_id")],
            ["lg._bindGroupCache.length",scalar("static_cast<double>(gpu.bind_group_cache.size())")],
            ["data._groups.length",scalar("static_cast<double>(data.groups.size())")],
            ["data._instanceCount",scalar("static_cast<double>(data.instance_count)")],["data._version",scalar("data.version")],
            ["data._dirtyStart",scalar("static_cast<double>(data.dirty_start)")],["data._dirtyEnd",scalar("static_cast<double>(data.dirty_end)")],
            ["TEXT_INSTANCE_BYTES",scalar(String(c.numericValue(c.variableInitializer(dataFile,"TEXT_INSTANCE_BYTES"),dataFile)))],
        ]);
        const lowerer=new PinnedNumericLowerer(file,{bindings,booleanAnd:true,booleanOr:true,
            calls:new Map([
                ["ensureStyleGpu",()=>"ensure_text_style_gpu(data,gpu,ops)"],
                ["ensureInstanceCapacity",(args:readonly string[])=>`ensure_text_layer_capacity(gpu,${args[2]},ops)`],
            ]),statement:(node,lowerer,indent)=>{
                if(ts.isVariableStatement(node) && node.declarationList.declarations.length===1) {
                    const variable=node.declarationList.declarations[0]!;
                    if(ts.isObjectBindingPattern(variable.name)) {
                        c.assertExpressionShape(variable.initializer!,"ensureSharedAtlasGpu(device,g._curveSet._atlas)","Standalone text atlas owner");
                        if(variable.name.elements.map(e=>`${e.propertyName?.getText()}:${e.name.getText()}`).join()!=="_rebuilt:rebuilt,_gpu:atlasGpu")
                            c.contractError(variable,"Standalone text atlas result changed.");
                        return [`${indent}auto atlas_result=ensure_text_atlas(data.payload->atlases.at(g.atlas_index),data.atlas_gpu.at(g.atlas_index),gpu.device_identity,ops);`,
                            `${indent}const auto& atlasGpu=*atlas_result.gpu;`];
                    }
                    if(!ts.isIdentifier(variable.name) || !variable.initializer)return undefined;
                    const name=variable.name.text, initial=variable.initializer;
                    const aliases: Record<string,readonly [string,string]>={
                        device:["rr._surface.engine._device",""],layer:["lg._layer","const auto& layer=*gpu.layer;"],data:["layer.data","auto& data=*layer.data;"],
                        g:["data._groups[i]!","const auto& g=data.groups.at(static_cast<std::size_t>(i));"],
                        cached:["lg._bindGroupCache[i]","const auto cached=static_cast<std::size_t>(i)<gpu.bind_group_cache.size()?gpu.bind_group_cache[static_cast<std::size_t>(i)]:nullptr;"],
                    };
                    const alias=aliases[name];
                    if(alias){c.assertExpressionShape(initial,alias[0],`Standalone text ${name} alias`);return alias[1]?[`${indent}${alias[1]}`]:[];}
                    if(name==="styleRecreated")c.assertExpressionShape(initial,"ensureStyleGpu(device,data,lg)","Standalone text style synchronization");
                    if(name==="view") {
                        if(!ts.isCallExpression(initial) || initial.arguments.length!==2)c.contractError(initial,"Standalone text instance view changed.");
                        c.assertExpressionShape(initial.expression,"data._instances.subarray","Standalone text instance view owner");
                        const start=lowerer.expression(initial.arguments[0]!),end=lowerer.expression(initial.arguments[1]!);
                        return [`${indent}const auto view=text_byte_range(data.payload->instances.bytes,(${start})*4.0,((${end})-(${start}))*4.0);`];
                    }
                }
                if(!ts.isExpressionStatement(node))return undefined;
                const expression=node.expression;
                if(ts.isBinaryExpression(expression)) {
                    const path=c.propertyPath(expression.left)?.join(".");
                    if(path==="lg._renderBundle") {
                        c.assertExpressionShape(expression,"lg._renderBundle=null","Standalone text bundle invalidation");return [`${indent}gpu.render_bundle.reset();`];
                    }
                    if(path==="lg._bindGroupCache.length") {
                        c.assertExpressionShape(expression,"lg._bindGroupCache.length=data._groups.length","Standalone text group cache truncation");
                        return [`${indent}gpu.bind_group_cache.resize(data.groups.size());`];
                    }
                    if(path==="data._dirtyStart" || path==="data._dirtyEnd") {
                        c.assertExpressionShape(expression,`${path}=0`,"Standalone text dirty reset");
                        return [`${indent}data.${path==="data._dirtyStart"?"dirty_start":"dirty_end"}=0;`];
                    }
                    if(ts.isElementAccessExpression(expression.left) && c.propertyPath(expression.left.expression)?.join(".")==="lg._bindGroupCache") {
                        c.assertExpressionShape(expression,`lg._bindGroupCache[i]={_bindGroup:device.createBindGroup({label:"text-renderer-bg0-"+g._curveSetId,layout:bindGroupLayout,entries:[
                            {binding:0,resource:{buffer:lg._textU}},{binding:1,resource:atlasGpu._curveTex.createView()},
                            {binding:2,resource:atlasGpu._bandTex.createView()},{binding:3,resource:{buffer:atlasGpu._metaBuf}},
                            {binding:4,resource:{buffer:lg._styleBuf}}]}),_atlasVersion:atlasGpu._uploadedVersion,_curveSetId:g._curveSetId}`,
                            "Standalone text bind-group cache descriptor");
                        return [`${indent}if(gpu.bind_group_cache.size()<=static_cast<std::size_t>(i))gpu.bind_group_cache.resize(static_cast<std::size_t>(i)+1);`,
                            `${indent}gpu.bind_group_cache[static_cast<std::size_t>(i)]=std::make_shared<TextLayerBindGroup>(TextLayerBindGroup{ops.create_bind_group(gpu,atlasGpu,layout),atlasGpu.uploaded_version,data.payload->atlases.at(g.atlas_index).curve_set_id});`];
                    }
                }
                if(ts.isCallExpression(expression) && c.propertyPath(expression.expression)?.join(".")==="device.queue.writeBuffer") {
                    if(expression.arguments.length!==5)c.contractError(expression,"Standalone text instance upload arity changed.");
                    for(const [index,shape] of [[0,"lg._instanceBuf"],[2,"view.buffer as ArrayBuffer"],[3,"view.byteOffset"],[4,"view.byteLength"]] as const)
                        c.assertExpressionShape(expression.arguments[index]!,shape,"Standalone text instance upload range");
                    return [`${indent}ops.write_renderable_buffer(gpu,TextBufferKind::instances,text_resource_size(${lowerer.expression(expression.arguments[1]!)}),view);`];
                }
                return undefined;
            }});
        return `// ${c.provenance(module,"uploadLayer","resource prefix precedes uniform synchronization")}
template<class Ops> void upload_text_layer_resources(TextLayerGpuState& gpu,const std::shared_ptr<void>& layout,Ops& ops) {
${lowerer.statements(statements.slice(0,boundary),"    ").join("\n")}
}`;
    }

    private update(): string {
        const c:LoweringContext=this.context;
        const {file,declaration}=c.functionDeclaration(module,"textRendererUpdate");
        const compare=c.functionDeclaration(module,"compareLayers");
        const comparison=new PinnedNumericLowerer(compare.file,{bindings:new Map([
            ["a.order",scalar("a->order")],["b.order",scalar("b->order")]]),calls:new Map(),returnValue:e=>e?comparison.expression(e):""});
        const lowerer=new PinnedNumericLowerer(file,{bindings:new Map<string,PinnedBinding>([
            ["rr._disposed",{cpp:"rr.disposed",type:"bool"}],
            ["rr._targetWidth",scalar("rr.target_width")],["rr._targetHeight",scalar("rr.target_height")],
            ["size.width",scalar("width")],["size.height",scalar("height")],
            ["rr._layers.length",scalar("static_cast<double>(rr.layers.size())")],
            ...this.gpuBindings("lg","lg->"),["pipeline",opaque("pipeline")],["variantPipeline",opaque("variantPipeline")],
            ["rr",opaque("rr")],["lg",opaque("lg")],["cache._bindGroupLayout",opaque("layout")],
            ["compareLayers",opaque("compare_text_layers")],
        ]),booleanOr:true,calls:new Map([
            ["rr._layers.sort",()=>"std::stable_sort(rr.layers.begin(),rr.layers.end(),[](const auto& a,const auto& b){return compare_text_layers(a,b)<0;})"],
            ["uploadLayer",()=>"upload_text_layer_resources(*lg,layout,ops); upload_text_layer_uniforms(*layer,*lg,rr.target_width,rr.target_height,[&](std::size_t offset,std::span<const std::uint8_t> bytes){ops.write_renderable_buffer(*lg,TextBufferKind::uniform,offset,bytes);})"],
        ]),forOf:(iterated,element)=>iterated==="rr._layers"&&element==="layer"?{
            range:"rr.layers",bindings:new Map([...this.layerBindings("layer","layer->"),["layer",opaque("layer")]])}:undefined,
        statement:(node,_lowerer,indent)=>{
            if(ts.isVariableStatement(node)&&node.declarationList.declarations.length===1){
                const variable=node.declarationList.declarations[0]!;
                if(ts.isObjectBindingPattern(variable.name)){
                    c.assertExpressionShape(variable.initializer!,"getOrCreateTextPipeline(rr._surface.engine,rr._surface.format,1,null,false)","Standalone text pipeline signature");
                    if(variable.name.elements.map(e=>`${e.propertyName?.getText()}:${e.name.getText()}`).join()!=="_pipeline:pipeline,_variantPipeline:variantPipeline,_cache:cache")c.contractError(variable,"Standalone text pipeline result changed.");
                    return [`${indent}const auto resolved=ops.resolve_text_renderer_pipeline();`,`${indent}const auto& pipeline=resolved.pipeline;`,`${indent}const auto& variantPipeline=resolved.variant_pipeline;`,`${indent}const auto& layout=resolved.layout;`];
                }
                const name=variable.name.getText();
                if(name==="size"){c.assertExpressionShape(variable.initializer!,"rr._surface.canvas","Standalone text target dimensions");return [];}
                if(name==="lg"){c.assertExpressionShape(variable.initializer!,"ensureLayerGpu(rr,layer)","Standalone text layer GPU owner");return [`${indent}const auto lg=ensure_text_layer_gpu(rr,layer,device_identity,ops);`];}
            }
            if(ts.isExpressionStatement(node)){
                const expression=node.expression;
                if(ts.isCallExpression(expression)&&c.propertyPath(expression.expression)?.join(".")==="rr._layers.sort")c.assertExpressionShape(expression,"rr._layers.sort(compareLayers)","Standalone text stable ordering");
                if(ts.isCallExpression(expression)&&c.propertyPath(expression.expression)?.join(".")==="uploadLayer")c.assertExpressionShape(expression,"uploadLayer(rr,lg,cache._bindGroupLayout)","Standalone text upload owner");
                if(ts.isBinaryExpression(expression)){
                    const path=c.propertyPath(expression.left)?.join(".");
                    if(path==="lg._bindGroupCache.length"){c.assertExpressionShape(expression,"lg._bindGroupCache.length=0","Text pipeline group-cache invalidation");return [`${indent}lg->bind_group_cache.clear();`];}
                    if(path==="lg._renderBundle"){c.assertExpressionShape(expression,"lg._renderBundle=null","Text pipeline bundle invalidation");return [`${indent}lg->render_bundle.reset();`];}
                }
            }
            return undefined;
        }});
        return `inline double compare_text_layers(const TextLayer& a,const TextLayer& b) {
${comparison.statements(compare.declaration.body!.statements,"    ").join("\n")}
}
template<class Ops> void update_text_renderer(TextRendererState& rr,double width,double height,const void* device_identity,Ops& ops) {
${lowerer.statements(declaration.body!.statements,"    ").join("\n")}
}`;
    }

    private record(): string {
        const c:LoweringContext=this.context;
        const {file,declaration}=c.functionDeclaration(module,"textRendererRecord");
        const bindings=new Map<string,PinnedBinding>([
            ["rr._disposed",{cpp:"rr.disposed",type:"bool"}],...this.gpuBindings("lg","lg->"),
            ["lg",{...opaque("lg"),absentCpp:"!lg"}],
            ["lg._pipeline",{...opaque("lg->pipeline"),absentCpp:"!lg->pipeline"}],
            ["data._instanceCount",scalar("static_cast<double>(data.instance_count)")],
            ["data._layoutVersion",scalar("data.layout_version")],
            ["data._groups.length",scalar("static_cast<double>(data.groups.size())")],
            ["g._slotCount",scalar("static_cast<double>(g.slot_count)")],["g._slotStart",scalar("static_cast<double>(g.slot_start)")],
            ["g._groupKey",opaque("g.group_key")],["g._curveSetId",opaque("data.payload->atlases.at(g.atlas_index).curve_set_id")],
            ["base",opaque("base")],["bound",opaque("bound")],["p",opaque("p")],["quadVertex",opaque("quadVertex")],
            ["bg",{...opaque("bg"),absentCpp:"!bg"}],
            ["visibleBundles.length",scalar("static_cast<double>(rr.visible_bundles.size())")],
            ["visibleBundles",opaque("rr.visible_bundles")],
        ]);
        const lowerer=new PinnedNumericLowerer(file,{bindings,booleanOr:true,returnValue:e=>e?lowerer.expression(e):"",expression:node=>{
            if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.EqualsEqualsToken&&c.propertyPath(node.left)?.join(".")==="lg._renderBundle"){
                c.assertExpressionShape(node,"lg._renderBundle==null","Text bundle absence check");return "!lg->render_bundle";
            }
            return undefined;
        },calls:new Map([
            ["visibleBundles.push",(args:readonly string[])=>`rr.visible_bundles.push_back(${args[0]})`],
            ["pass.executeBundles",()=>"replay_text_bundles(rr.visible_bundles,ops)"],["pass.end",()=>"ops.end_text_renderer_pass()"],
        ]),forOf:(iterated,element)=>iterated==="rr._layers"&&element==="layer"?{
            range:"rr.layers",bindings:this.layerBindings("layer","layer->")}:undefined,
        statement:(node,lowerer,indent)=>{
            if(ts.isVariableStatement(node)&&node.declarationList.declarations.length===1){
                const variable=node.declarationList.declarations[0]!;
                const name=variable.name.getText();
                const aliases:Record<string,readonly[string,string]>={
                    eng:["rr._surface.engine",""],device:["eng._device",""],encoder:["eng._currentEncoder",""],swapView:["rr._surface.scRT._colorView!",""],format:["rr._surface.format",""],
                    quadVertex:["getTextPipelineCache(eng)._quadVertexBuffer","const auto quadVertex=ops.text_renderer_quad();"],
                    visibleBundles:["rr._visibleBundles",""],lg:["rr._layerGpu.get(layer)","const auto lg=find_text_layer_gpu(rr,layer);"],
                    data:["layer.data","const auto& data=*layer->data;"],g:["data._groups[i]!","const auto& g=data.groups.at(static_cast<std::size_t>(i));"],
                    bg:["lg._bindGroupCache[i]?._bindGroup","const auto bg=static_cast<std::size_t>(i)<lg->bind_group_cache.size()&&lg->bind_group_cache[static_cast<std::size_t>(i)]?lg->bind_group_cache[static_cast<std::size_t>(i)]->group:nullptr;"],
                    be:['device.createRenderBundleEncoder({colorFormats:[format],sampleCount:1})',"auto be=std::make_shared<TextCommandBundle>();"],
                    pass:['encoder.beginRenderPass({colorAttachments:[{view:swapView,clearValue:rr.clearColor,loadOp:rr._clear?"clear":"load",storeOp:"store"}]})',"ops.begin_text_renderer_pass(rr);"],
                };
                const alias=aliases[name];
                if(alias){c.assertExpressionShape(variable.initializer!,alias[0],`Standalone text record ${name} boundary`);return alias[1]?[`${indent}${alias[1]}`]:[];}
                if(["base","bound","p"].includes(name))return [`${indent}auto ${name}=${lowerer.expression(variable.initializer!)};`];
            }
            if(!ts.isExpressionStatement(node))return undefined;
            const expression=node.expression;
            if(ts.isBinaryExpression(expression)){
                const path=c.propertyPath(expression.left)?.join(".");
                if(path==="visibleBundles.length"){c.assertExpressionShape(expression,"visibleBundles.length=0","Text visible bundle reset");return [`${indent}rr.visible_bundles.clear();`];}
                if(path==="lg._renderBundle"){c.assertExpressionShape(expression,"lg._renderBundle=be.finish()","Text bundle retention");return [`${indent}lg->render_bundle=be;`];}
            }
            if(!ts.isCallExpression(expression))return undefined;
            const path=c.propertyPath(expression.expression)?.join(".");
            if(path==="be.setPipeline"){
                if(expression.arguments.length!==1)c.contractError(expression,"Text bundle pipeline arity changed.");
                return [`${indent}be->commands.push_back({TextBundleOp::pipeline,${lowerer.expression(expression.arguments[0]!)}});`];
            }
            if(path==="be.setVertexBuffer"){
                const slot=c.numericValue(expression.arguments[0]!,file);
                if(slot!==0&&slot!==1)c.contractError(expression,"Text bundle vertex slot changed.");
                c.assertExpressionShape(expression,slot===0?"be.setVertexBuffer(0,quadVertex)":"be.setVertexBuffer(1,lg._instanceBuf)","Text bundle vertex owner");
                return [`${indent}be->commands.push_back({TextBundleOp::${slot===0?"quad":"instances"},${slot===0?"quadVertex":"ops.retain_instance_buffer(*lg)"}});`];
            }
            if(path==="be.setBindGroup"){
                c.assertExpressionShape(expression,"be.setBindGroup(0,bg)","Text bundle group slot");return [`${indent}be->commands.push_back({TextBundleOp::group,bg});`];
            }
            if(path==="be.draw"){
                if(expression.arguments.length!==4)c.contractError(expression,"Text bundle draw arity changed.");
                return [`${indent}be->commands.push_back({TextBundleOp::draw,{}, {${expression.arguments.map(arg=>`text_resource_size(${lowerer.expression(arg)})`).join(",")}}});`];
            }
            if(path==="pass.executeBundles")c.assertExpressionShape(expression,"pass.executeBundles(visibleBundles)","Text bundle execution list");
            if(path==="pass.end")c.assertExpressionShape(expression,"pass.end()","Text render pass end");
            return undefined;
        }});
        return `template<class Ops> void replay_text_bundles(const std::vector<std::shared_ptr<void>>& bundles,Ops& ops) {
    for(const auto& opaque:bundles)for(const auto& command:std::static_pointer_cast<TextCommandBundle>(opaque)->commands){
        switch(command.op){
            case TextBundleOp::pipeline:ops.set_pipeline(command.resource);break;
            case TextBundleOp::quad:ops.set_quad_vertex_buffer(command.resource);break;
            case TextBundleOp::instances:ops.set_instance_buffer(command.resource);break;
            case TextBundleOp::group:ops.set_bind_group(command.resource);break;
            case TextBundleOp::draw:ops.draw(command.draw[0],command.draw[1],command.draw[2],command.draw[3]);break;
        }
    }
}
template<class Ops> double record_text_renderer(TextRendererState& rr,Ops& ops) {
${lowerer.statements(declaration.body!.statements,"    ").join("\n")}
}`;
    }

    header(): string {
        return `#pragma once
#include <bblite/text_renderer.hpp>
#include <bblite/upstream_text_gpu.hpp>
namespace bbl {
template<std::size_t N> std::span<const std::uint8_t> text_layer_bytes(const std::array<float,N>& values) {
    return {reinterpret_cast<const std::uint8_t*>(values.data()),values.size()*sizeof(float)};
}
${this.matrix()}
${this.factories()}
${this.ensureGpu()}
${this.capacity()}
${this.resources()}
${this.uniforms()}
${this.update()}
${this.record()}
} // namespace bbl
`;
    }
}
