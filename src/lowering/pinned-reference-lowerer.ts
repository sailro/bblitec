import ts from "typescript";
import { doubleLiteral } from "../cpp-literals.js";
import type { LoweringContext } from "./context.js";
import { PINNED_ASSIGNMENT_OPERATORS, PINNED_BOOLEAN_OPERATORS, pinnedNumericMathCalls } from "./pinned-operators.js";

export interface ReferenceValue { cpp: string; type: string }
export interface ReferenceFunction { cpp: string; parameters: readonly string[]; requiredParameters: number; returns: string }
export interface ReferenceSchema {
    records: ReadonlyMap<string, ReadonlyMap<string, string>>;
    functions: ReadonlyMap<string, ReferenceFunction>;
    bindings: Map<string, ReferenceValue>;
    returnType: string;
    numberAliases?: ReadonlySet<string>;
    typeAliases?: ReadonlyMap<string, string>;
    expression?: (node: ts.Expression, expected: string | undefined, lowerer: PinnedReferenceLowerer) => ReferenceValue | undefined;
    statement?: (node: ts.Statement, lowerer: PinnedReferenceLowerer, indent: string) => string | undefined;
}

export const referenceTuple = (types: readonly string[]): string => `tuple:${JSON.stringify(types)}`;
const tupleTypes = (type: string): string[] | undefined => type.startsWith("tuple:") ? JSON.parse(type.slice(6)) as string[] : undefined;

/** Pinned arithmetic over aliased records/arrays. JS Ref/Array retain object identity;
 * numeric-only kernels continue to use PinnedNumericLowerer and value records. */
export class PinnedReferenceLowerer {
    private readonly math = pinnedNumericMathCalls();
    private temporary = 0;

    public constructor(private readonly context: LoweringContext, private readonly schema: ReferenceSchema) {}

    public type(node: ts.TypeNode): string {
        const alias = this.schema.typeAliases?.get(node.getText(node.getSourceFile()));
        if (alias) return alias;
        if (node.kind === ts.SyntaxKind.NumberKeyword) return "number";
        if (node.kind === ts.SyntaxKind.BooleanKeyword) return "boolean";
        if (node.kind === ts.SyntaxKind.VoidKeyword) return "void";
        if (ts.isArrayTypeNode(node)) return `${this.type(node.elementType)}[]`;
        if (ts.isParenthesizedTypeNode(node)) return this.type(node.type);
        if (ts.isUnionTypeNode(node)) {
            const present = node.types.filter(type => !(ts.isLiteralTypeNode(type) && type.literal.kind === ts.SyntaxKind.NullKeyword));
            if (present.length === 1) return this.type(present[0]!);
        }
        if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
            const name = node.typeName.text;
            if (this.schema.numberAliases?.has(name)) return "number";
            if (this.schema.records.has(name)) return name;
            if (name === "ArrayLike" && node.typeArguments?.length === 1) return `${this.type(node.typeArguments[0]!)}[]`;
            if (name === "Map" && node.typeArguments?.length === 2) return `map:${JSON.stringify(node.typeArguments.map(type => this.type(type)))}`;
        }
        return this.context.contractError(node, "Pinned reference type has no native representation.");
    }

    public storage(type: string): string {
        if (type === "number") return "double";
        if (type === "boolean") return "bool";
        if (type === "void") return "void";
        if (type.startsWith("optional:")) return `std::optional<${this.storage(type.slice(9))}>`;
        const tuple = tupleTypes(type);
        if (tuple) return `std::tuple<${tuple.map(type => this.storage(type)).join(", ")}>`;
        if (type.startsWith("map:")) return `js::Map<${(JSON.parse(type.slice(4)) as string[]).map(type => this.storage(type)).join(", ")}>`;
        if (type.endsWith("[]")) return `js::Array<${this.storage(type.slice(0, -2))}>`;
        if (this.schema.records.has(type)) return `js::Ref<${type}>`;
        throw new Error(`Pinned reference storage is not represented: ${type}.`);
    }

    private scoped<T>(body: () => T): T {
        const saved = new Map(this.schema.bindings);
        try { return body(); } finally {
            this.schema.bindings.clear();
            for (const [key, value] of saved) this.schema.bindings.set(key, value);
        }
    }

    public statements(statements: readonly ts.Statement[], indent = "    "): string {
        return statements.map(statement => this.statement(statement, indent)).join("\n");
    }

    private branch(statement: ts.Statement, indent: string): string {
        return this.scoped(() => ts.isBlock(statement)
            ? this.statements(statement.statements, indent) : this.statement(statement, indent));
    }

    private declaration(declaration: ts.VariableDeclaration): string {
        if (!declaration.initializer)
            return this.context.contractError(declaration, "Pinned reference local requires a named initializer.");
        if (ts.isArrayBindingPattern(declaration.name)) {
            const value = this.expression(declaration.initializer);
            const fields = tupleTypes(value.type);
            if (!fields || declaration.name.elements.length > fields.length) return this.context.contractError(declaration, "Pinned tuple destructuring requires represented fields.");
            const temporary = `tuple_${this.temporary++}`;
            return `auto ${temporary} = ${value.cpp};\n${declaration.name.elements.map((element, index) => {
                if (ts.isOmittedExpression(element)) return "";
                if (!ts.isIdentifier(element.name) || element.initializer || element.dotDotDotToken) return this.context.contractError(element, "Pinned tuple binding must be an ordinary name.");
                const cpp = `local_${element.name.text}`;
                this.schema.bindings.set(element.name.text, { cpp, type: fields[index]! });
                return `    auto ${cpp} = std::get<${index}>(${temporary});`;
            }).join("\n")}`;
        }
        if (!ts.isIdentifier(declaration.name)) return this.context.contractError(declaration, "Pinned reference local requires a named initializer.");
        const name = declaration.name.text;
        const cpp = `local_${name}`;
        const expected = declaration.type ? this.type(declaration.type) : undefined;
        const value = this.expression(declaration.initializer, expected);
        this.schema.bindings.set(name, { cpp, type: value.type });
        return `${value.type.startsWith("function:") ? "auto" : this.storage(value.type)} ${cpp} = ${value.cpp}`;
    }

    public statement(statement: ts.Statement, indent: string): string {
        const adapted = this.schema.statement?.(statement, this, indent);
        if (adapted !== undefined) return adapted;
        if (ts.isBlock(statement)) return `${indent}{\n${this.branch(statement, indent + "    ")}\n${indent}}`;
        if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.map(declaration => `${indent}${this.declaration(declaration)};`).join("\n");
        if (ts.isExpressionStatement(statement)) return `${indent}${this.expression(statement.expression).cpp};`;
        if (ts.isReturnStatement(statement)) return `${indent}return${statement.expression ? ` ${this.expression(statement.expression, this.schema.returnType).cpp}` : ""};`;
        if (ts.isIfStatement(statement)) return `${indent}if (${this.expression(statement.expression).cpp}) {\n${this.branch(statement.thenStatement, indent + "    ")}\n${indent}}${statement.elseStatement ? ` else {\n${this.branch(statement.elseStatement, indent + "    ")}\n${indent}}` : ""}`;
        if (ts.isWhileStatement(statement)) return `${indent}while (${this.expression(statement.expression).cpp}) {\n${this.branch(statement.statement, indent + "    ")}\n${indent}}`;
        if (ts.isForOfStatement(statement)) return this.scoped(() => {
            if (statement.awaitModifier || !ts.isVariableDeclarationList(statement.initializer) || statement.initializer.declarations.length !== 1 ||
                !ts.isIdentifier(statement.initializer.declarations[0]!.name)) return this.context.contractError(statement, "Pinned for-of loop requires one ordinary binding.");
            const values = this.expression(statement.expression);
            if (!values.type.endsWith("[]")) return this.context.contractError(statement.expression, "Pinned for-of requires an array.");
            const name = statement.initializer.declarations[0]!.name as ts.Identifier;
            const array = `iterable_${this.temporary++}`, index = `index_${this.temporary++}`, item = `local_${name.text}`;
            this.schema.bindings.set(name.text, { cpp: item, type: values.type.slice(0, -2) });
            return `${indent}{ auto ${array} = ${values.cpp};\n${indent}for (std::size_t ${index} = 0; ${index} < ${array}.size(); ++${index}) {\n${indent}    auto ${item} = ${array}.at(${index});\n${this.branch(statement.statement, indent + "    ")}\n${indent}}\n${indent}}`;
        });
        if (ts.isForStatement(statement)) return this.scoped(() => {
            if (!statement.initializer || !ts.isVariableDeclarationList(statement.initializer) || statement.initializer.declarations.length !== 1 || !statement.condition || !statement.incrementor)
                return this.context.contractError(statement, "Pinned reference loop requires initializer, guard and increment.");
            const initial = this.declaration(statement.initializer.declarations[0]!);
            return `${indent}for (${initial}; ${this.expression(statement.condition).cpp}; ${this.expression(statement.incrementor).cpp}) {\n${this.branch(statement.statement, indent + "    ")}\n${indent}}`;
        });
        if (ts.isSwitchStatement(statement)) {
            const clauses = statement.caseBlock.clauses.map(clause => `${indent}${ts.isCaseClause(clause) ? `case ${this.context.numericValue(clause.expression, clause.getSourceFile())}` : "default"}:\n${this.scoped(() => this.statements(clause.statements, indent + "    "))}`).join("\n");
            return `${indent}switch (static_cast<int>(${this.expression(statement.expression).cpp})) {\n${clauses}\n${indent}}`;
        }
        if (ts.isBreakStatement(statement) && !statement.label) return `${indent}break;`;
        if (ts.isContinueStatement(statement) && !statement.label) return `${indent}continue;`;
        return this.context.contractError(statement, "Pinned reference statement has no native representation.");
    }

    public expression(input: ts.Expression, expected?: string): ReferenceValue {
        const node = this.context.unwrapExpression(input);
        const exact = this.schema.bindings.get(node.getText(node.getSourceFile()));
        if (exact) return exact.type === `optional:${expected}` ? { cpp: `${exact.cpp}.value()`, type: expected! } : exact;
        const adapted = this.schema.expression?.(node, expected, this);
        if (adapted) return adapted;
        if (ts.isNumericLiteral(node)) return { cpp: doubleLiteral(Number(node.text)), type: "number" };
        if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword)
            return { cpp: node.kind === ts.SyntaxKind.TrueKeyword ? "true" : "false", type: "boolean" };
        if (node.kind === ts.SyntaxKind.NullKeyword && expected && (this.schema.records.has(expected) || expected.startsWith("optional:"))) return { cpp: `${this.storage(expected)}{}`, type: expected };
        if (ts.isIdentifier(node)) return this.context.contractError(node, "Unbound pinned reference identifier.");
        if (ts.isPropertyAccessExpression(node)) {
            const owner = this.expression(node.expression);
            if (node.name.text === "length" && owner.type.endsWith("[]")) return { cpp: `static_cast<double>(${owner.cpp}.size())`, type: "number" };
            const type = this.schema.records.get(owner.type)?.get(node.name.text);
            if (!type) return this.context.contractError(node, "Pinned reference member has no declared field.");
            if (node.questionDotToken) return { cpp: `(${owner.cpp} ? std::optional<${this.storage(type)}>{${owner.cpp}->${node.name.text}} : std::nullopt)`, type: `optional:${type}` };
            return { cpp: `${owner.cpp}->${node.name.text}`, type };
        }
        if (ts.isElementAccessExpression(node)) {
            const owner = this.expression(node.expression);
            const tuple = tupleTypes(owner.type);
            if (tuple) {
                const index = this.context.numericValue(node.argumentExpression, node.getSourceFile());
                if (!Number.isInteger(index) || !tuple[index]) return this.context.contractError(node, "Pinned tuple index has no represented field.");
                return { cpp: `std::get<${index}>(${owner.cpp})`, type: tuple[index]! };
            }
            if (!owner.type.endsWith("[]")) return this.context.contractError(node, "Pinned reference indexing requires an array.");
            return { cpp: `${owner.cpp}.at(js::array_index(${this.expression(node.argumentExpression).cpp}))`, type: owner.type.slice(0, -2) };
        }
        if (ts.isObjectLiteralExpression(node)) {
            const names = node.properties.map(property => property.name && ts.isIdentifier(property.name) ? property.name.text : this.context.contractError(property, "Pinned record field requires an identifier."));
            const type = expected ?? [...this.schema.records].find(([, fields]) => fields.size === names.length && names.every(name => fields.has(name)))?.[0];
            const fields = type && this.schema.records.get(type);
            if (!type || !fields || fields.size !== names.length) return this.context.contractError(node, "Pinned record literal has no complete declared shape.");
            const cpp = `record_${this.temporary++}`;
            const writes = node.properties.map((property, index) => {
                const name = names[index]!;
                const value = ts.isPropertyAssignment(property) ? property.initializer : ts.isShorthandPropertyAssignment(property) ? property.name : this.context.contractError(property, "Pinned record member must store a value.");
                const field = fields.get(name);
                if (!field) return this.context.contractError(property, "Pinned record literal added an undeclared field.");
                return `${cpp}->${name} = ${this.expression(value, field).cpp};`;
            });
            return { cpp: `([&]() { auto ${cpp} = js::make_ref<${type}>(); ${writes.join(" ")} return ${cpp}; }())`, type };
        }
        if (ts.isArrayLiteralExpression(node)) {
            const tuple = expected && tupleTypes(expected);
            const values = node.elements.map((value, i) => this.expression(value, expected?.endsWith("[]") ? expected.slice(0, -2) : tuple?.[i]));
            const type = expected ?? (values.length && values.every(value => value.type === values[0]!.type) ? `${values[0]!.type}[]` : referenceTuple(values.map(value => value.type)));
            if (!type.endsWith("[]") && !tupleTypes(type)) return this.context.contractError(node, "Pinned array literal requires an array or tuple type.");
            return { cpp: `${this.storage(type)}{${values.map(value => value.cpp).join(", ")}}`, type };
        }
        if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
            if (node.expression.text === "Array" && (node.typeArguments?.length === 1 || expected?.endsWith("[]")) && node.arguments?.length === 1) {
                const type = node.typeArguments?.[0] ? `${this.type(node.typeArguments[0])}[]` : expected!;
                return { cpp: `${this.storage(type)}(js::array_index(${this.expression(node.arguments[0]!).cpp}))`, type };
            }
            if (node.expression.text === "Map" && node.typeArguments?.length === 2 && !node.arguments?.length) {
                const type = `map:${JSON.stringify(node.typeArguments.map(type => this.type(type)))}`;
                return { cpp: `${this.storage(type)}{}`, type };
            }
        }
        if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
            const value = this.expression(node.operand);
            const operator = new Map([[ts.SyntaxKind.MinusToken, "-"], [ts.SyntaxKind.PlusToken, "+"], [ts.SyntaxKind.ExclamationToken, "!"], [ts.SyntaxKind.PlusPlusToken, "++"], [ts.SyntaxKind.MinusMinusToken, "--"]]).get(node.operator);
            if (!operator) return this.context.contractError(node, "Pinned reference unary operator is not represented.");
            return { cpp: `(${ts.isPrefixUnaryExpression(node) ? operator + value.cpp : value.cpp + operator})`, type: operator === "!" ? "boolean" : value.type };
        }
        if (ts.isBinaryExpression(node)) {
            if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left) && node.left.name.text === "length") {
                const array = this.expression(node.left.expression);
                if (array.type.endsWith("[]")) return { cpp: `js::array_truncate(${array.cpp}, ${this.expression(node.right).cpp})`, type: "void" };
            }
            const left = this.expression(node.left);
            if (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && left.type.startsWith("optional:")) {
                const type = left.type.slice(9), right = this.expression(node.right, type);
                return { cpp: `([&]() { const auto optional = ${left.cpp}; return optional ? *optional : ${right.cpp}; }())`, type };
            }
            const right = this.expression(node.right, left.type);
            if (node.operatorToken.kind === ts.SyntaxKind.PercentToken) return { cpp: `std::fmod(${left.cpp}, ${right.cpp})`, type: "number" };
            const operator = PINNED_ASSIGNMENT_OPERATORS.get(node.operatorToken.kind) ?? PINNED_BOOLEAN_OPERATORS.get(node.operatorToken.kind) ??
                new Map([[ts.SyntaxKind.ExclamationEqualsEqualsToken, "!="], [ts.SyntaxKind.LessThanEqualsToken, "<="], [ts.SyntaxKind.GreaterThanEqualsToken, ">="]]).get(node.operatorToken.kind);
            if (!operator) return this.context.contractError(node, "Pinned reference binary operator is not represented.");
            return { cpp: `(${left.cpp} ${operator} ${right.cpp})`, type: ["==", "!=", "<", ">", "<=", ">=", "&&", "||"].includes(operator) ? "boolean" : left.type };
        }
        if (ts.isConditionalExpression(node)) {
            const yes = this.expression(node.whenTrue, expected);
            const no = this.expression(node.whenFalse, yes.type);
            if (yes.type !== no.type) return this.context.contractError(node, "Pinned conditional branches require one represented type.");
            return { cpp: `(${this.expression(node.condition).cpp} ? ${yes.cpp} : ${no.cpp})`, type: yes.type };
        }
        if (ts.isCallExpression(node)) return this.call(node);
        if (ts.isArrowFunction(node) && node.parameters.length === 0 && node.type && !ts.isBlock(node.body)) {
            const type = this.type(node.type);
            return { cpp: `[&]() { return ${this.expression(node.body, type).cpp}; }`, type: `function:${type}` };
        }
        return this.context.contractError(node, "Pinned reference expression has no native representation.");
    }

    private call(node: ts.CallExpression): ReferenceValue {
        const path = node.expression.getText(node.getSourceFile());
        const math = this.math.get(path);
        if (math) return { cpp: math(node.arguments.map(argument => this.expression(argument).cpp)), type: "number" };
        const fn = this.schema.functions.get(path);
        if (fn) {
            if (node.arguments.length < fn.requiredParameters || node.arguments.length > fn.parameters.length)
                return this.context.contractError(node, "Pinned reference call does not match its declared argument count.");
            return { cpp: `${fn.cpp}(${node.arguments.map((argument, index) => this.expression(argument, fn.parameters[index]).cpp).join(", ")})`, type: fn.returns };
        }
        if (ts.isIdentifier(node.expression)) {
            const closure = this.schema.bindings.get(node.expression.text);
            if (closure?.type.startsWith("function:") && node.arguments.length === 0) return { cpp: `${closure.cpp}()`, type: closure.type.slice(9) };
        }
        if (ts.isPropertyAccessExpression(node.expression)) {
            const owner = this.expression(node.expression.expression);
            const method = node.expression.name.text;
            if (owner.type.startsWith("map:")) {
                const [key, value] = JSON.parse(owner.type.slice(4)) as [string, string];
                if (method === "get" && node.arguments.length === 1 && this.schema.records.has(value)) return { cpp: `${owner.cpp}.get(${this.expression(node.arguments[0]!, key).cpp})`, type: value };
                if (method === "set" && node.arguments.length === 2) return { cpp: `${owner.cpp}.set(${this.expression(node.arguments[0]!, key).cpp}, ${this.expression(node.arguments[1]!, value).cpp})`, type: owner.type };
            }
            if (owner.type.endsWith("[]") && method === "splice" && node.arguments.length === 2 && ts.isNumericLiteral(node.arguments[1]!) && node.arguments[1]!.text === "1")
                return { cpp: `js::array_splice_one(${owner.cpp}, ${this.expression(node.arguments[0]!).cpp})`, type: "void" };
            if (owner.type.endsWith("[]") && ["filter", "findIndex"].includes(method) && node.arguments.length === 1 && ts.isArrowFunction(node.arguments[0]!)) return this.scoped(() => {
                const callback = node.arguments[0] as ts.ArrowFunction;
                const parameter = callback.parameters[0];
                if (callback.parameters.length !== 1 || !parameter || !ts.isIdentifier(parameter.name) || ts.isBlock(callback.body)) return this.context.contractError(callback, "Pinned array predicate requires one named argument and expression.");
                const item = `predicate_${this.temporary++}`, array = `values_${this.temporary++}`, index = `index_${this.temporary++}`;
                this.schema.bindings.set(parameter.name.text, { cpp: item, type: owner.type.slice(0, -2) });
                const predicate = this.expression(callback.body).cpp;
                const output = method === "filter" ? "filtered" : "found";
                const initial = method === "filter" ? `${this.storage(owner.type)} filtered;` : "double found = -1;";
                const accept = method === "filter" ? `filtered.push_back(${item});` : `found = static_cast<double>(${index}); break;`;
                return { cpp: `([&]() { auto ${array} = ${owner.cpp}; ${initial} const auto length = ${array}.size(); for (std::size_t ${index} = 0; ${index} < length; ++${index}) { auto ${item} = ${array}.at(${index}); if (${predicate}) { ${accept} } } return ${output}; }())`, type: method === "filter" ? owner.type : "number" };
            });
            if (owner.type.endsWith("[]") && node.arguments.length === 1) {
                const argument = this.expression(node.arguments[0]!, owner.type.slice(0, -2));
                if (method === "push") return { cpp: `${owner.cpp}.push_back(${argument.cpp})`, type: "void" };
                if (method === "indexOf") return { cpp: `js::array_index_of(${owner.cpp}, ${argument.cpp})`, type: "number" };
            }
        }
        return this.context.contractError(node, "Pinned reference call has no declared native target.");
    }
}
