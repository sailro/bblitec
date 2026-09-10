import ts from "typescript";

/** Instance fields include the properties declared by constructor parameters. */
export function classInstanceProperties(
    declaration: ts.ClassDeclaration,
): (ts.PropertyDeclaration | ts.ParameterDeclaration)[] {
    return declaration.members.flatMap<ts.PropertyDeclaration | ts.ParameterDeclaration>(member => {
        if (ts.isPropertyDeclaration(member) &&
            (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Static) === 0) return [member];
        if (ts.isConstructorDeclaration(member))
            return member.parameters.filter(parameter => ts.isParameterPropertyDeclaration(parameter, member));
        return [];
    });
}
