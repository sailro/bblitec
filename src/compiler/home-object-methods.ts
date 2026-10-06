import { basename } from "node:path";
import ts from "typescript";
import { forEachAnalysisNode } from "./analysis-walk.js";
import type { DataType } from "./data-types.js";
import type { LoweringServices } from "./lowering-services.js";
import { propertyNameText, unwrapExpression, wrappedParent } from "./syntax.js";
import type { Value } from "./types.js";
import { functionUsesDynamicThis } from "./user-functions.js";

/**
 * An object literal's method that reads `this` is called with its home
 * object as receiver as long as its function value never leaves that
 * object: every read of the property is the callee of a member call.
 * These are the program's other reads, which could call it with another
 * receiver (`const f = o.m`, `o.m.call(x)`, `{...o}`, `Object.values(o)`).
 */
interface MethodValueReads {
    /** Property names read as values, with the first node reading each. */
    readonly named: ReadonlyMap<string, ts.Node>;
    /** Objects read wholesale or by a computed key: any property may be read. */
    readonly wholesale: readonly ts.Node[];
}

/** Library functions that read every own property of an argument. */
const wholesaleReaders: ReadonlyMap<string, ReadonlySet<string>> = new Map([
    [
        "Object",
        new Set([
            "assign",
            "entries",
            "values",
            "getOwnPropertyDescriptor",
            "getOwnPropertyDescriptors",
        ]),
    ],
    ["Reflect", new Set(["get", "getOwnPropertyDescriptor", "apply"])],
]);

type LibraryGlobal = (expression: ts.Expression) => string | undefined;

const programReads = new WeakMap<ts.Program, MethodValueReads>();

/** Whether a member read is a call's callee, a write target or a `typeof`/`delete` operand. */
function readsOnlyAsMember(access: ts.Expression): boolean {
    const parent = wrappedParent(access);
    return (
        (ts.isCallExpression(parent) &&
            unwrapExpression(parent.expression) === access) ||
        (ts.isTaggedTemplateExpression(parent) &&
            unwrapExpression(parent.tag) === access) ||
        (ts.isBinaryExpression(parent) &&
            unwrapExpression(parent.left) === access &&
            parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) ||
        ts.isDeleteExpression(parent) ||
        ts.isTypeOfExpression(parent)
    );
}

/** The property names a destructuring assignment target reads. */
function assignmentPatternNames(
    pattern: ts.Expression,
    names: (name: string, node: ts.Node) => void,
): void {
    const target = unwrapExpression(pattern);
    if (ts.isArrayLiteralExpression(target)) {
        for (const element of target.elements)
            assignmentPatternNames(
                ts.isSpreadElement(element) ? element.expression : element,
                names,
            );
        return;
    }
    if (!ts.isObjectLiteralExpression(target)) return;
    for (const property of target.properties) {
        if (ts.isShorthandPropertyAssignment(property))
            names(property.name.text, property);
        else if (ts.isPropertyAssignment(property)) {
            const name = propertyNameText(property.name);
            if (name !== undefined) names(name, property);
            assignmentPatternNames(property.initializer, names);
        }
    }
}

function collectReads(
    program: ts.Program,
    libraryGlobal: LibraryGlobal,
): MethodValueReads {
    const named = new Map<string, ts.Node>();
    const wholesale: ts.Node[] = [];
    const read = (name: string, node: ts.Node): void => {
        if (!named.has(name)) named.set(name, node);
    };
    for (const file of program.getSourceFiles()) {
        if (file.isDeclarationFile) continue;
        forEachAnalysisNode(
            file,
            (node) => {
                if (ts.isPropertyAccessExpression(node)) {
                    if (!readsOnlyAsMember(node)) read(node.name.text, node);
                } else if (ts.isElementAccessExpression(node)) {
                    const key = node.argumentExpression;
                    if (
                        ts.isStringLiteralLike(key) ||
                        ts.isNumericLiteral(key)
                    ) {
                        if (!readsOnlyAsMember(node)) read(key.text, node);
                    } else wholesale.push(node.expression);
                } else if (ts.isBindingElement(node)) {
                    if (ts.isObjectBindingPattern(node.parent)) {
                        const name = node.dotDotDotToken
                            ? undefined
                            : node.propertyName
                              ? propertyNameText(node.propertyName)
                              : ts.isIdentifier(node.name)
                                ? node.name.text
                                : undefined;
                        if (name !== undefined) read(name, node);
                        else wholesale.push(node.parent);
                    }
                } else if (
                    ts.isBinaryExpression(node) &&
                    node.operatorToken.kind === ts.SyntaxKind.EqualsToken
                ) {
                    assignmentPatternNames(node.left, read);
                } else if (ts.isSpreadAssignment(node)) {
                    wholesale.push(node.expression);
                } else if (
                    ts.isCallExpression(node) &&
                    ts.isPropertyAccessExpression(node.expression)
                ) {
                    const owner = libraryGlobal(node.expression.expression);
                    if (
                        owner !== undefined &&
                        wholesaleReaders
                            .get(owner)
                            ?.has(node.expression.name.text) === true
                    )
                        wholesale.push(
                            ...node.arguments.filter(
                                (argument) => !ts.isSpreadElement(argument),
                            ),
                        );
                }
            },
            { types: "skip" },
        );
    }
    return { named, wholesale };
}

/** Whether any member of `type` declares a property called `name`. */
function mayHaveProperty(
    checker: ts.TypeChecker,
    type: ts.Type,
    name: string,
): boolean {
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true;
    const members = type.isUnionOrIntersection() ? type.types : [type];
    return members.some(
        (member) =>
            (member.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 ||
            checker.getPropertyOfType(checker.getApparentType(member), name) !==
                undefined,
    );
}

/**
 * The first place the program could read method `name`'s function value
 * rather than call it through its object, or undefined when every read is
 * a member call's callee.
 */
function methodValueRead(
    program: ts.Program,
    checker: ts.TypeChecker,
    libraryGlobal: LibraryGlobal,
    name: string,
): ts.Node | undefined {
    let reads = programReads.get(program);
    if (!reads) {
        reads = collectReads(program, libraryGlobal);
        programReads.set(program, reads);
    }
    return (
        reads.named.get(name) ??
        reads.wholesale.find((node) =>
            mayHaveProperty(checker, checker.getTypeAtLocation(node), name),
        )
    );
}

/** An object literal's own method or function-expression property whose body reads `this`. */
export function readsHomeObject(
    node: ts.Node,
): node is ts.MethodDeclaration | ts.FunctionExpression {
    let owner: ts.Node = node.parent;
    if (ts.isFunctionExpression(node)) {
        owner = wrappedParent(node);
        if (!ts.isPropertyAssignment(owner)) return false;
        owner = owner.parent;
    } else if (!ts.isMethodDeclaration(node)) return false;
    return ts.isObjectLiteralExpression(owner) && functionUsesDynamicThis(node);
}

/**
 * The shared cell an object literal's `this`-reading methods read as their
 * receiver, declared before the methods' closures capture it; the caller
 * stores the created object in it. A method whose function value never
 * leaves its object is only called as a member of that object, so `this`
 * is the object the literal creates; any other read of the value refuses.
 */
export function homeObjectReceiver(
    context: Pick<
        LoweringServices,
        | "program"
        | "checker"
        | "libraryGlobal"
        | "fail"
        | "dataTypes"
        | "allocateTemporaryCppName"
        | "reachJsData"
        | "emit"
        | "registerNativeBinding"
    >,
    dataType: DataType<"struct">,
    methods: readonly { readonly name: string; readonly method: ts.Node }[],
    node: ts.Node,
): Value | undefined {
    if (!methods.length) return undefined;
    if (!context.dataTypes.isReferenceStruct(dataType.name))
        context.fail(
            node,
            "An object literal method reading `this` requires shared native object storage.",
        );
    for (const { name, method } of methods) {
        const read = methodValueRead(
            context.program,
            context.checker,
            (expression) => context.libraryGlobal(expression),
            name,
        );
        if (!read) continue;
        const file = read.getSourceFile();
        const line = file.getLineAndCharacterOfPosition(read.getStart()).line;
        context.fail(
            method,
            `Method '${name}' reads \`this\`, and ${basename(file.fileName)}:${line + 1} reads its function value, which could call it with another receiver.`,
        );
    }
    const cell = context.allocateTemporaryCppName("home_object");
    const cppType = context.dataTypes.cppType(dataType);
    context.reachJsData();
    context.emit({
        kind: "declaration",
        type: "auto",
        name: cell,
        initializer: `bbl::js::make_gc_shared<${cppType}>()`,
    });
    return {
        kind: "data",
        cpp: `(*${cell})`,
        dataType,
        sharedStorageCpp: cell,
        nativeCaptures: [
            context.registerNativeBinding(
                cell,
                false,
                false,
                `std::shared_ptr<${cppType}>`,
            ),
        ],
    };
}
