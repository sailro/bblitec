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
const moduleDetails = new Map();
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
    const details = { functionBodies: 0, classes: 0, imports: [], dynamicImports: [], workers: [] };
    moduleDetails.set(file, details);
    function visit(node) {
        if (ts.isFunctionLike(node) && node.body) {
            functions.push({ ...location(node), start: node.getStart(file), end: node.end,
                name: node.name?.getText(file) ?? "<anonymous>" });
            details.functionBodies++;
            if (node.asteriskToken) add("syntax:generator", node);
        }
        if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) details.classes++;
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
            const symbol = checker.getSymbolAtLocation(node.moduleSpecifier);
            const target = symbol?.declarations?.find(ts.isSourceFile);
            const bindings = ts.isImportDeclaration(node) ? node.importClause?.namedBindings : node.exportClause;
            const namedTypesOnly = bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)) &&
                bindings.elements.length > 0 && bindings.elements.every(binding => binding.isTypeOnly) &&
                !(ts.isImportDeclaration(node) && node.importClause?.name);
            details.imports.push({ ...location(node), specifier: node.moduleSpecifier.text,
                target: target ? pathOf(target) : null,
                typeOnly: Boolean(node.isTypeOnly || node.importClause?.isTypeOnly || namedTypesOnly) });
        }
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
            callCount++;
            const signature = checker.getResolvedSignature(node);
            if (!signature?.declaration) {
                unresolvedCalls++;
                add("unresolved:call", node);
            }
            if (ts.isNewExpression(node) && libraryMember(checker.getSymbolAtLocation(node.expression)) === "standard:Worker") {
                details.workers.push({ ...location(node), argument: node.arguments?.[0]?.getText(file) });
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
            if (!symbol && ts.isPropertyAccessExpression(node)) {
                add("unresolved:property", node, { member: node.name.text,
                    receiverType: checker.typeToString(receiver), operation: ts.isCallExpression(node.parent) && node.parent.expression === node ? "call" : "access" });
            }
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
        if (ts.isHeritageClause(node) && node.token === ts.SyntaxKind.ExtendsKeyword &&
            (ts.isClassDeclaration(node.parent) || ts.isClassExpression(node.parent))) add("syntax:class-extends", node);
        if (ts.isAwaitExpression(node)) {
            add("syntax:await", node);
            for (let parent = node.parent; parent && !ts.isFunctionLike(parent); parent = parent.parent) {
                if (ts.isCatchClause(parent)) add("syntax:await-in-catch", node);
                if (ts.isBlock(parent) && ts.isTryStatement(parent.parent) && parent.parent.finallyBlock === parent) add("syntax:await-in-finally", node);
            }
        }
        if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
            if (node.type.kind === ts.SyntaxKind.AnyKeyword) add("syntax:any-assertion", node);
        }
        if (ts.isDeleteExpression(node)) add("syntax:delete", node);
        if (ts.isGetAccessorDeclaration(node)) add("syntax:get-accessor", node);
        if (ts.isSetAccessorDeclaration(node)) add("syntax:set-accessor", node);
        if (ts.isForOfStatement(node) && node.awaitModifier) add("syntax:for-await", node);
        if (ts.isObjectLiteralExpression(node) && node.properties.some(property =>
            property.name && ts.isComputedPropertyName(property.name))) add("syntax:computed-record-key", node);
        if (ts.isYieldExpression(node)) add("syntax:yield", node);
        if (ts.isRegularExpressionLiteral(node)) add("syntax:regexp-literal", node);
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
            add("syntax:dynamic-import", node);
            details.dynamicImports.push({ ...location(node), argument: node.arguments[0]?.getText(file) });
        }
        ts.forEachChild(node, visit);
    }
    visit(file);
}
const report = {
    schemaVersion: 2,
    createdAt: new Date().toISOString(),
    scope: "Static local import graph, including function bodies that may never execute. Not compiler reachability or compilation coverage.",
    entry: pathOf(program.getSourceFile(entryPath)),
    totals: { files: local.length, functions: functions.length, calls: callCount, unresolvedCalls, requirementGroups: requirements.size },
    files: local.map(file => ({ path: pathOf(file), sha256: createHash("sha256").update(file.text).digest("hex"), ...moduleDetails.get(file) }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    functions,
    requirements: [...requirements.values()].sort((a, b) => a.id.localeCompare(b.id)),
};
mkdirSync(dirname(resolve(output)), { recursive: true });
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.totals));
console.log(`Wrote ${resolve(output)}. Source inventory only; native compilation and execution require separate evidence.`);
