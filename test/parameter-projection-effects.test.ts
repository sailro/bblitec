import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { planImportedModuleInitializers } from "../src/compiler/module-initializers.js";
import {
    callArgumentProjectionIsReadOnly,
    parameterProjectionIsReadOnly,
} from "../src/compiler/parameter-projection-effects.js";
import { createCompilerProgram } from "../src/compiler/program.js";
import { CompilerSymbols } from "../src/compiler/symbols.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("parameter projections separate copied geometry from retained, written and unknown fields", () => {
    const source = `
        type Point={x:number;y:number};
        type Options={points:Point[];samples:number[];state:{value:number}};
        declare const options:Options;
        declare function opaque(value:Point[]):void;
        function copyNested(options:{nested:{points:readonly Point[]};state:{value:number}}):number[] {
            const {points}=options.nested;
            const result:number[]=[];
            for(const point of points)result.push(point.x,point.y);
            return result;
        }
        function wrapped(options:Options):number[] {
            return copyNested({nested:{points:options.points},state:options.state});
        }
        function scalarCopy(options:Options):number[] {return [...options.samples];}
        function retained(options:Options):{points:Point[]} {return {points:options.points.slice()};}
        function written(options:Options):void {const {points}=options;points[0]!.x++;}
        function unknown(options:Options):void {opaque(options.points);}
        function captured(options:Options):()=>number {return ()=>options.points[0]!.x;}
        function selected(options:Options):Point|undefined {return options.points.at(0);}
        function thrown(options:Options):void {throw options.points;}
        function comma(options:Options):Point[] {return (0,options.points);}
        async function awaited(options:Options):Promise<Point[]> {return await options.points;}
        function sibling(options:{type:number;state:{value:number}}):number {options.state.value++;return options.type;}
        function scalarWrite(options:{type:number;state:{value:number}}):number {const alias=options;alias.type++;return options.type;}
        const arrow=(options:Options)=>options.points;
        function defaultAlias(options:{points?:Point[];fallback:Point[]}):Point[] {const {points=options.fallback}=options;return points;}
        interface Root {kind:number;child:{owner:Root|null}}
        function backWrite(child:Root['child']):void {child.owner!.kind=2;}
        function backReference(root:Root):number {backWrite(root.child);return root.kind;}
        function sharedChildren(options:{left:Point;right:Point}):number {options.left.x++;return options.right.x;}
        function sharedEscape(options:{left:Point[];right:Point[]}):Point[] {return options.left;}
        declare const root:Root,pair:{left:Point;right:Point},arrays:{left:Point[];right:Point[]};
        function callback(options:Options,run:(points:Point[])=>void):void {run(options.points);}
        class Accessor {get points():Point[]{return options.points;}}
        function getter(options:Accessor):number {return options.points.length;}
        wrapped(options);
        scalarCopy(options);
        retained(options);
        written(options);
        unknown(options);
        captured(options);
        selected(options);
        thrown(options);
        comma(options);
        awaited(options);
        sibling({type:1,state:{value:0}});
        scalarWrite({type:1,state:{value:0}});
        arrow(options);
        defaultAlias({fallback:options.points});
        backReference(root);
        sharedChildren(pair);
        sharedEscape(arrays);
        callback(options,opaque);
        getter(new Accessor());
    `;
    const { sourceFile, checker } = createCompilerProgram(
        source,
        resolve("artifacts/parameter-projections/analysis.ts"),
    );
    const calls = new Map(
        sourceFile.statements.flatMap((statement) =>
            ts.isExpressionStatement(statement) &&
            ts.isCallExpression(statement.expression) &&
            ts.isIdentifier(statement.expression.expression)
                ? [
                      [
                          statement.expression.expression.text,
                          statement.expression,
                      ] as const,
                  ]
                : [],
        ),
    );
    assert.equal(
        callArgumentProjectionIsReadOnly(checker, calls.get("wrapped")!, 0, [
            "points",
        ]),
        true,
    );
    assert.equal(
        callArgumentProjectionIsReadOnly(checker, calls.get("sibling")!, 0, [
            "type",
        ]),
        false,
    );
    assert.equal(
        callArgumentProjectionIsReadOnly(
            checker,
            calls.get("scalarWrite")!,
            0,
            ["type"],
        ),
        false,
    );
    assert.equal(
        callArgumentProjectionIsReadOnly(checker, calls.get("wrapped")!, 0, [
            "state",
        ]),
        true,
    );
    assert.equal(
        callArgumentProjectionIsReadOnly(checker, calls.get("scalarCopy")!, 0, [
            "samples",
        ]),
        true,
    );
    assert.equal(
        callArgumentProjectionIsReadOnly(
            checker,
            calls.get("defaultAlias")!,
            0,
            ["fallback"],
        ),
        false,
    );
    assert.equal(
        callArgumentProjectionIsReadOnly(
            checker,
            calls.get("backReference")!,
            0,
            ["kind"],
        ),
        false,
    );
    assert.equal(
        callArgumentProjectionIsReadOnly(
            checker,
            calls.get("sharedChildren")!,
            0,
            ["right"],
        ),
        false,
    );
    assert.equal(
        callArgumentProjectionIsReadOnly(
            checker,
            calls.get("sharedEscape")!,
            0,
            ["right"],
        ),
        false,
    );
    for (const name of [
        "retained",
        "written",
        "unknown",
        "captured",
        "selected",
        "thrown",
        "comma",
        "awaited",
        "arrow",
        "callback",
        "getter",
    ])
        assert.equal(
            callArgumentProjectionIsReadOnly(checker, calls.get(name)!, 0, [
                "points",
            ]),
            false,
            name,
        );
});

test("pinned line builders preserve copied geometry without exempting retained probe children", () => {
    const directory = resolve("artifacts/parameter-projections-pinned");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        join(directory, "geometry.ts"),
        `export const lines=[[{x:0,y:0,z:0},{x:1,y:2,z:3}]];`,
    );
    writeFileSync(
        join(directory, "probe.ts"),
        `export const position=[1,2,3] as const;`,
    );
    const source = `
        import {addToScene,createLineSystem,updateLineSystem,createPbrLocalEnvironmentProbeSet} from "@babylonjs/lite";
        import type {EngineContext,Mesh,SceneNode,LineMaterial,SceneContext,EnvironmentTextures} from "@babylonjs/lite";
        import {lines} from "./geometry.js";
        import {position} from "./probe.js";
        declare module "@babylonjs/lite" {interface ShaderMaterial {get projectionFlag():number;}}
        declare const engine:EngineContext,mesh:Mesh,material:LineMaterial,scene:SceneContext,environment:EnvironmentTextures;
        declare function opaqueMaterial(value:LineMaterial):void;
        function handleCallback(options:{lines:readonly unknown[];material:LineMaterial}):number {
            opaqueMaterial(options.material);
            return options.lines.length;
        }
        function handleAlias(options:{mesh:Mesh;node:SceneNode}):Mesh {return options.mesh;}
        function handleAccessor(options:{lines:readonly unknown[];material:LineMaterial}):number {return options.material.projectionFlag;}
        function handleRetain(options:{lines:readonly unknown[];material:LineMaterial}):LineMaterial {return options.material;}
        createLineSystem(engine,{lines,material});
        addToScene(scene,createLineSystem(engine,{lines,material}));
        updateLineSystem(engine,mesh,{lines});
        createPbrLocalEnvironmentProbeSet(scene,{probes:[{environment,influencePosition:position}]});
    `;
    const { program, sourceFile, checker } = createCompilerProgram(
        source,
        join(directory, "entry.ts"),
    );
    assert.deepEqual(
        planImportedModuleInitializers(
            program,
            sourceFile,
            checker,
            new CompilerSymbols(checker),
        ).map((file) => basename(file.fileName)),
        ["probe.ts"],
    );
    const handler = sourceFile.statements.find(
        (statement): statement is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(statement) &&
            statement.name?.text === "handleCallback",
    )!;
    assert.equal(
        parameterProjectionIsReadOnly(checker, handler, 0, ["lines"]),
        false,
    );
    const alias = sourceFile.statements.find(
        (statement): statement is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(statement) &&
            statement.name?.text === "handleAlias",
    )!;
    assert.equal(
        parameterProjectionIsReadOnly(checker, alias, 0, ["node"]),
        false,
    );
    for (const [name, expected] of [
        ["handleAccessor", false],
        ["handleRetain", true],
    ] as const) {
        const declaration = sourceFile.statements.find(
            (statement): statement is ts.FunctionDeclaration =>
                ts.isFunctionDeclaration(statement) &&
                statement.name?.text === name,
        )!;
        assert.equal(
            parameterProjectionIsReadOnly(checker, declaration, 0, ["lines"]),
            expected,
            name,
        );
    }
});

test("copied parameter projections preserve scalar effects and retained child mutation", (t) => {
    const source = `
        type Point={x:number;y:number};
        const points:Point[]=[{x:2,y:3},{x:5,y:7}];
        const samples=[4,8];
        let effects=0;
        function next():number {effects++;return effects;}
        function copy(options:{points:readonly Point[];scalar:number}):number[] {
            const {points}=options;
            const result:number[]=[];
            for(let i=0;i<points.length;i++) {
                const point=points[i]!;
                result.push(point.x+point.y+options.scalar);
            }
            return result;
        }
        function retain(options:{points:Point[]}):Point[] {return options.points.slice();}
        function clone(options:{samples:number[]}):number[] {return [...options.samples];}
        function sibling<T extends {type:number;color:{r:number}}>(entry:T):number {entry.color.r++;return entry.type;}
        function rewrite<T extends {type:number;color:{r:number}}>(entry:T):number {const alias=entry;alias.type++;return entry.type;}
        function tupleSibling<T extends {type:number;color:[number,number,number]}>(entry:T):number {entry.color[0]++;return entry.type;}
        function main():void {
            const copied=copy({points,scalar:next()});
            const kept=retain({points});
            const cloned=clone({samples});
            const entry={type:7,color:{r:2}};
            const oldType=sibling(entry);
            const newType=rewrite(entry);
            const tupleEntry:{type:number;color:[number,number,number]}={type:9,color:[1,2,3]};
            const tupleType=tupleSibling(tupleEntry);
            kept[0]!.x=20;
            samples[0]=40;
            if(effects!==1||copied[0]!==6||copied[1]!==13||points[0]!.x!==20||cloned[0]!==4||oldType!==7||newType!==8||entry.type!==8||entry.color.r!==3||tupleType!==9||tupleEntry.color[0]!==2)
                throw new Error("projection ownership");
        }
        main();
    `;
    runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
    );
    const result = compileSource(source);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(tools, "parameter-projections", result.cpp);
});
