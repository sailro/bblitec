import ts from "typescript";
import type {LoweringContext} from "./context.js";
import {lowerPinnedBody} from "./pinned-body-lowerer.js";
import type {PinnedBinding} from "./pinned-numeric-lowerer.js";
import {pinnedNumericMathCalls} from "./pinned-operators.js";

/** Property groups use the source clock and public controls within mixed manager traversal. */
export function lowerPropertyAnimationPlayback(context:LoweringContext):string {
    const module="src/animation/property-animation.ts",groupModule="src/animation/animation-group.ts";
    const {file,declaration}=context.functionDeclaration(module,"createPointerAnimationGroup");
    const controller=context.unwrapExpression(context.variableInitializer(declaration,"ctrl"));
    if(!ts.isObjectLiteralExpression(controller))context.contractError(controller,"Expected source property controller.");
    const tick=controller.properties.find(property=>ts.isMethodDeclaration(property)&&context.propertyName(property.name)==="tick");
    if(!tick||!ts.isMethodDeclaration(tick)||!tick.body)context.contractError(controller,"Expected source property controller tick.");
    const bindings=new Map<string,PinnedBinding>([
        ["ctrl.time",{cpp:"time",type:"scalar"}], ["ctrl.playing",{cpp:"group.playing",type:"bool"}],
        ["ctrl.speedRatio",{cpp:"static_cast<double>(group.speed_ratio)",type:"scalar"}], ["ctrl.loop",{cpp:"group.loop",type:"bool"}],
        ["deltaMs",{cpp:"delta_ms",type:"scalar"}], ["fromTime",{cpp:"static_cast<double>(group.from_time)",type:"scalar"}],
        ["toTime",{cpp:"static_cast<double>(group.to_time)",type:"scalar"}],
    ]);
    const clock=lowerPinnedBody(file,tick.body.statements,{bindings,calls:pinnedNumericMathCalls(),booleanAnd:true,booleanOr:true,
        statement(statement,_lowerer,indent){
            if(!ts.isForStatement(statement))return undefined;
            context.assertStatementShapes(tick,[statement],`for (let trackIndex = 0; trackIndex < tracks.length; trackIndex++) {
                const track = tracks[trackIndex]!;
                evaluateSampler(track.sampler, ctrl.time, track.stride, track.quaternion, _pointerScratch, 0);
                track.writer(_pointerScratch, 0);
            }`,"Property sampler and writer storage callback");
            return [`${indent}apply_pose(time);`];
        },
    });
    const controls=["playAnimation","pauseAnimation","stopAnimation"].map(name=>{
        const source=context.functionDeclaration(groupModule,name);
        return `template<class Group> void property_${name}(Group& group) {
${lowerPinnedBody(source.file,source.declaration.body!.statements,{bindings:new Map<string,PinnedBinding>([
            ["group.isPlaying",{cpp:"group.playing",type:"bool"}], ["group._stopped",{cpp:"group.stopped",type:"bool"}],
            ["group.currentTime",{cpp:"group.current_time",type:"scalar"}],
        ]),calls:new Map()})}
}`;
    }).join("\n");
    const core=context.functionDeclaration(groupModule,"tickAnimationCore");
    const coreBody=lowerPinnedBody(core.file,core.declaration.body!.statements,{
        bindings:new Map<string,PinnedBinding>([
            ["group._stopped",{cpp:"group.stopped",type:"bool"}], ["group._ctrl",{cpp:"true",type:"bool",staticBoolean:true}],
            ["group.currentTime",{cpp:"group.current_time",type:"scalar"}], ["group._ctrl.time",{cpp:"static_cast<float>(time)",type:"scalar"}],
            ["deltaMs",{cpp:"delta_ms",type:"scalar"}], ["engine",{cpp:"true",type:"bool"}],
        ]),calls:new Map(),booleanAnd:true,booleanOr:true,
        statement(statement,_lowerer,indent){
            if(!ts.isExpressionStatement(statement)||!ts.isCallExpression(statement.expression))return undefined;
            const call=statement.expression;
            if(context.expressionMatchesShape(call.expression,"syncControllerFromGroup")){
                context.assertExpressionShape(call,"syncControllerFromGroup(group, group._ctrl)","Property playback source state sync");
                return [`${indent}double time = static_cast<double>(group.current_time);`];
            }
            if(context.expressionMatchesShape(call.expression,"group._ctrl.tick")){
                context.assertExpressionShape(call,"group._ctrl.tick(deltaMs, engine)","Property playback controller invocation");
                return [`${indent}property_controller_tick(group,time,delta_ms,apply_pose);`];
            }
            return undefined;
        },
    });
    return `// ${context.provenance(groupModule,"playAnimation,pauseAnimation,stopAnimation")}
${controls}
// ${context.provenance(module,"createPointerAnimationGroup.tick")}
template<class Group,class Apply> void property_controller_tick(const Group& group,double& time,double delta_ms,Apply apply_pose) {
${clock}
}
// ${context.provenance(groupModule,"tickAnimationCore")}
template<class Group,class Apply> void tick_property_animation_group(Group& group,double delta_ms,Apply apply_pose) {
${coreBody}
}`;
}
