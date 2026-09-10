import ts from "typescript";
import type {LoweringContext} from "./context.js";
import {lowerPinnedBody} from "./pinned-body-lowerer.js";
import type {PinnedBinding} from "./pinned-numeric-lowerer.js";

/** Source category and task traversal after the manager clock guard; admitted tasks are attached groups. */
export function lowerAnimationManagerDispatch(context:LoweringContext):string {
    const module="src/animation/animation-manager.ts",{file,declaration}=context.functionDeclaration(module,"updateAnimationManager");
    const statements=declaration.body!.statements;
    const prefix=statements[0],guard=statements[1];
    if(!prefix||!ts.isVariableStatement(prefix)||prefix.declarationList.declarations.length!==1||
        !ts.isIdentifier(prefix.declarationList.declarations[0]!.name)||prefix.declarationList.declarations[0]!.name.text!=="step"||!guard||!ts.isIfStatement(guard))
        context.contractError(declaration,"Expected source manager clock prefix before task traversal.");
    // These compiler-admitted tasks can only be attached, never deactivated or re-categorized.
    const task=context.functionDeclaration(module,"addAnimationTask");
    context.expectShapeCount(task.declaration,"task.active = true","Attached animation task activity");
    const taskModule="src/animation/animation-group-task.ts";
    const groupTask=context.functionDeclaration(taskModule,"addAnimationGroup");
    context.expectShapeCount(groupTask.declaration,"category: ANIMATION_GROUP_TASK_CATEGORY","Attached animation task category");
    const bindings=new Map<string,PinnedBinding>([
        ["step",{cpp:"step",type:"scalar"}],
        ["handledCategory",{cpp:"handled",type:"bool",absentCpp:"!handled"}],
        ["manager._taskCategory",{cpp:"true",type:"bool",staticBoolean:true}],
        ["tasks.length",{cpp:"static_cast<std::int64_t>(tasks.size())",type:"scalar"}],
        ["task.active",{cpp:"true",type:"bool",staticBoolean:true}],
        ["task._category",{cpp:"true",type:"bool",staticBoolean:true}],
    ]);
    const body=lowerPinnedBody(file,statements.slice(2),{bindings,calls:new Map(),booleanAnd:true,booleanOr:true,
        expression(node){
            if(context.expressionMatchesShape(node,"manager._preUpdate?.(manager, step)"))return "pre_update()";
            if(context.expressionMatchesShape(node,"manager._taskCategoryHandler?.(manager, step) ? manager._taskCategory : undefined"))return "category_handler()";
            if(context.expressionMatchesShape(node,"manager.animations.slice()"))return "manager.ordered_groups";
            if(context.expressionMatchesShape(node,"tasks[index]!"))return "tasks.at(static_cast<std::size_t>(index))";
            if(context.expressionMatchesShape(node,"task._update(manager, step, task)"))return "tick(task, step)";
            return undefined;
        },
        statement(statement,lowerer,indent){
            if(!ts.isVariableStatement(statement)||statement.declarationList.declarations.length!==1)return undefined;
            const variable=statement.declarationList.declarations[0]!;
            if(!ts.isIdentifier(variable.name)||!variable.initializer)return undefined;
            const names=new Map([["handledCategory","const bool handled"],["tasks","const auto tasks"],["task","const auto& task"]]);
            const cpp=names.get(variable.name.text);return cpp?[`${indent}${cpp} = ${lowerer.expression(variable.initializer)};`]:undefined;
        },
    });
    return `// ${context.provenance(module,"updateAnimationManager task dispatch")}
template<class Manager,class PreUpdate,class CategoryHandler,class Tick>
void dispatch_animation_manager_groups(Manager& manager,double step,PreUpdate pre_update,CategoryHandler category_handler,Tick tick) {
${body}
}`;
}
