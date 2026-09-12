#!/usr/bin/env node
// Read-only inventory of the compiler's import graph. This does not lower code
// and must never label a file or API as supported merely because it was found.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";
import { createCompilerProgram } from "../dist/src/compiler/program.js";

const [entry, output] = process.argv.slice(2);
if (!entry || !output || process.argv.length !== 4) {
    throw new Error("Usage: node tools/project-requirements.mjs <entry.ts> <report.json>");
}
const entryPath = resolve(entry);
const root = dirname(entryPath);
const { program, checker } = createCompilerProgram(readFileSync(entryPath, "utf8"), entryPath);
const local = program.getSourceFiles().filter(file =>
    !file.isDeclarationFile && !program.isSourceFileFromExternalLibrary(file));
const requirements = new Map();
const functions = [];
let unresolvedCalls = 0;
let callCount = 0;
const pathOf = file => relative(root, file.fileName).replaceAll("\\", "/");
const location = node => {
    const file = node.getSourceFile();
    const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file));
    return { file: pathOf(file), line: line + 1, column: character + 1 };
};
function add(id, node, detail) {
    if (!requirements.has(id)) requirements.set(id, { id, assessment: "unassessed", sites: [] });
    requirements.get(id).sites.push({ ...location(node), ...(detail ? { detail } : {}) });
}
function libraryMember(symbol) {
    const declaration = symbol?.declarations?.find(candidate =>
        program.isSourceFileDefaultLibrary(candidate.getSourceFile()) ||
        program.isSourceFileFromExternalLibrary(candidate.getSourceFile()));
    if (!declaration) return undefined;
    const owner = declaration.parent;
    const name = ts.isInterfaceDeclaration(owner) || ts.isClassDeclaration(owner)
        ? `${owner.name?.text ?? "anonymous"}.${symbol.name}` : symbol.name;
    const source = declaration.getSourceFile();
    return `${program.isSourceFileDefaultLibrary(source) ? "standard" : "package"}:${name}`;
}
function argumentShape(node) {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return "callback";
    if (node.kind === ts.SyntaxKind.TrueKeyword) return "true";
    if (node.kind === ts.SyntaxKind.FalseKeyword) return "false";
    if (ts.isObjectLiteralExpression(node)) return `object:{${node.properties.map(property =>
        property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
            ? property.name.text : "computed-or-spread").sort().join(",")}}`;
    const type = checker.getTypeAtLocation(node);
    if (type.getCallSignatures().length) return "stored-callback";
    return ts.SyntaxKind[node.kind];
}
for (const file of local) {
    function visit(node) {
        if (ts.isFunctionLike(node) && node.body) functions.push(location(node));
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
            callCount++;
            const signature = checker.getResolvedSignature(node);
            if (!signature?.declaration) {
                unresolvedCalls++;
                add("unresolved:call", node);
            }
            if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
                const receiver = checker.getTypeAtLocation(node.expression.expression);
                if (checker.isTupleType(receiver)) add(`tuple:method:${node.expression.name.text}`, node);
            }
        }
        if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
            const member = ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression;
            const receiver = checker.getTypeAtLocation(node.expression);
            if (ts.isElementAccessExpression(node) && checker.isTupleType(receiver)) {
                const index = checker.getTypeAtLocation(member);
                if (!(index.flags & (ts.TypeFlags.NumberLiteral | ts.TypeFlags.StringLiteral))) {
                    const write = ts.isBinaryExpression(node.parent) && node.parent.left === node &&
                        node.parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
                        node.parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
                    add(`tuple:dynamic-${write ? "write" : "read"}`, node);
                }
            }
            const symbol = checker.getSymbolAtLocation(member);
            const id = libraryMember(symbol);
            if (id) {
                const call = ts.isCallExpression(node.parent) && node.parent.expression === node ? node.parent : undefined;
                const detail = call ? { arguments: call.arguments.map(argumentShape) } : { operation: "access" };
                if (call && ts.isPropertyAccessExpression(node) &&
                    ["addEventListener", "removeEventListener"].includes(node.name.text)) {
                    detail.event = call.arguments[0] && ts.isStringLiteralLike(call.arguments[0])
                        ? call.arguments[0].text : "<dynamic>";
                    detail.receiverType = checker.typeToString(receiver);
                }
                add(id, node, detail);
            }
        } else if (ts.isIdentifier(node) &&
            (ts.isCallExpression(node.parent) || ts.isNewExpression(node.parent)) && node.parent.expression === node) {
            let symbol = checker.getSymbolAtLocation(node);
            if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
            const id = libraryMember(symbol);
            if (id) add(id, node, { arguments: (node.parent.arguments ?? []).map(argumentShape) });
        }
        if (ts.isBindingElement(node) && node.dotDotDotToken) add("syntax:rest-binding", node);
        if (ts.isParameter(node) && node.dotDotDotToken) add("syntax:rest-parameter", node);
        if (ts.isSpreadElement(node)) add("syntax:spread-element", node);
        if (ts.isSpreadAssignment(node)) add("syntax:spread-property", node);
        if (ts.isPrivateIdentifier(node)) add("syntax:private-member", node);
        if (ts.isClassStaticBlockDeclaration(node)) add("syntax:class-static-block", node);
        if (ts.isHeritageClause(node) && node.token === ts.SyntaxKind.ExtendsKeyword) add("syntax:extends", node);
        if (ts.isAwaitExpression(node)) add("syntax:await", node);
        if (ts.isYieldExpression(node)) add("syntax:yield", node);
        if (ts.isRegularExpressionLiteral(node)) add("syntax:regexp-literal", node);
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) add("syntax:dynamic-import", node);
        ts.forEachChild(node, visit);
    }
    visit(file);
}
const report = {
    schemaVersion: 1,
    scope: "Static local import graph, including function bodies that may never execute. Not compiler reachability or compilation coverage.",
    entry: pathOf(program.getSourceFile(entryPath)),
    totals: { files: local.length, functions: functions.length, calls: callCount, unresolvedCalls, requirementGroups: requirements.size },
    files: local.map(file => ({ path: pathOf(file), sha256: createHash("sha256").update(file.text).digest("hex") }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    functions,
    requirements: [...requirements.values()].sort((a, b) => a.id.localeCompare(b.id)),
};
mkdirSync(dirname(resolve(output)), { recursive: true });
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.totals));
console.log(`Wrote ${resolve(output)}. All groups are unassessed; native compilation and execution require separate evidence.`);
