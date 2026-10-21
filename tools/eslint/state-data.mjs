/**
 * Keep persisted login context behind the state-machine persistence boundary.
 * Alias tracking covers variable declarations, including destructured defaults;
 * parameter-bound and reassignment-based aliases are not fully tracked.
 */
export const noDirectStateData = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      opaque:
        "Pass explicit session fields to loginSessions.create/update. Whole sessions or opaque spreads can overwrite state_data; use the state-machine persistence boundary for context.",
      direct:
        "Write login session context through state-machines/login-session-data (machine events), not directly to state_data.",
    },
  },
  create(context) {
    function isKey(node, computed = false) {
      return (
        (!computed &&
          node?.type === "Identifier" &&
          node.name === "state_data") ||
        (node?.type === "Literal" && node.value === "state_data") ||
        (node?.type === "TemplateLiteral" &&
          node.expressions.length === 0 &&
          node.quasis[0].value.cooked === "state_data")
      );
    }
    function isMember(node) {
      return (
        node?.type === "MemberExpression" && isKey(node.property, node.computed)
      );
    }
    function checkTarget(node) {
      if (!node) return;
      if (isMember(node)) context.report({ node, messageId: "direct" });
      if (node.type === "ObjectPattern") {
        for (const property of node.properties)
          checkTarget(property.value ?? property.argument);
      }
      if (node.type === "ArrayPattern") node.elements.forEach(checkTarget);
      if (node.type === "AssignmentPattern") checkTarget(node.left);
    }
    function explicitPayload(node) {
      if (node?.type === "ObjectExpression") {
        return node.properties.every(
          (p) => p.type !== "SpreadElement" || explicitPayload(p.argument),
        );
      }
      if (node?.type === "ConditionalExpression") {
        return (
          explicitPayload(node.consequent) && explicitPayload(node.alternate)
        );
      }
      return false;
    }
    function staticName(node, computed = false) {
      if (!computed && node?.type === "Identifier") return node.name;
      if (node?.type === "Literal") return node.value;
      if (node?.type === "TemplateLiteral" && node.expressions.length === 0)
        return node.quasis[0].value.cooked;
    }
    function sessionAdapter(node, seen = new Set()) {
      if (node?.type === "ChainExpression")
        return sessionAdapter(node.expression, seen);
      if (node?.type === "MemberExpression")
        return staticName(node.property, node.computed) === "loginSessions";
      if (node?.type !== "Identifier") return false;
      if (node.name === "loginSessions") return true;
      if (seen.has(node.name)) return false;
      seen.add(node.name);
      let scope = context.sourceCode.getScope(node);
      while (scope) {
        const variable = scope.set.get(node.name);
        if (variable)
          return variable.defs.some((definition) => {
            const declaration = definition.node;
            if (declaration.type !== "VariableDeclarator") return false;
            if (declaration.id.type === "ObjectPattern")
              return declaration.id.properties.some(
                (property) =>
                  property.type === "Property" &&
                  staticName(property.key, property.computed) ===
                    "loginSessions" &&
                  (property.value.type === "AssignmentPattern"
                    ? property.value.left.name
                    : property.value.name) === node.name,
              );
            return sessionAdapter(declaration.init, seen);
          });
        scope = scope.upper;
      }
      return false;
    }
    return {
      // Includes payloads in variables/spreads, shorthand, and computed keys;
      // destructuring a session for reading remains allowed.
      Property(node) {
        if (
          node.parent.type === "ObjectExpression" &&
          isKey(node.key, node.computed)
        ) {
          context.report({ node, messageId: "direct" });
        }
      },
      AssignmentExpression: (node) => checkTarget(node.left),
      UpdateExpression: (node) => checkTarget(node.argument),
      UnaryExpression(node) {
        if (node.operator === "delete") checkTarget(node.argument);
      },
      CallExpression(node) {
        const callee =
          node.callee.type === "ChainExpression"
            ? node.callee.expression
            : node.callee;
        if (
          callee.type === "MemberExpression" &&
          sessionAdapter(callee.object) &&
          ["create", "update"].includes(
            staticName(callee.property, callee.computed),
          )
        ) {
          const payload =
            node.arguments[
              staticName(callee.property, callee.computed) === "create" ? 1 : 2
            ];
          if (!explicitPayload(payload))
            context.report({ node: payload ?? node, messageId: "opaque" });
        }

        if (
          callee.type === "MemberExpression" &&
          ["Object", "Reflect"].includes(callee.object.name) &&
          ["defineProperty", "set", "deleteProperty"].includes(
            callee.property.name,
          ) &&
          isKey(node.arguments[1], true)
        ) {
          context.report({ node, messageId: "direct" });
        }
      },
    };
  },
};

export const stateDataConfig = {
  files: ["packages/authhero/src/**/*.{ts,tsx}"],
  ignores: ["packages/authhero/src/state-machines/login-session-data.ts"],
  plugins: {
    "authhero-state": { rules: { "no-direct-state-data": noDirectStateData } },
  },
  rules: { "authhero-state/no-direct-state-data": "error" },
};
