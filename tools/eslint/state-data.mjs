/** Keep persisted login context behind the state-machine persistence boundary. */
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
        const callee = node.callee;
        if (
          callee.type === "MemberExpression" &&
          callee.object.type === "MemberExpression" &&
          callee.object.property.name === "loginSessions" &&
          ["create", "update"].includes(callee.property.name)
        ) {
          const payload =
            node.arguments[callee.property.name === "create" ? 1 : 2];
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
