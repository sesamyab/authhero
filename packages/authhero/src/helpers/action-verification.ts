import { parse, type AnyNode, type MemberExpression } from "acorn";
import {
  TRIGGER_API_SHAPES,
  TRIGGER_FUNCTION_NAMES,
} from "@authhero/adapter-interfaces";
import { managementError } from "../errors/management-api-error";

export function normalizeActionTrigger(id: string): string {
  return id === "post-login" ? "post-user-login" : id;
}

export interface ActionVerification {
  valid: boolean;
  errors: string[];
}

/** Static checks only: never evaluate untrusted code in the API process. */
export function verifyActionCode(
  code: string,
  triggers: readonly { id: string }[],
): ActionVerification {
  const errors: string[] = [];
  let program: ReturnType<typeof parse>;
  try {
    // Actions are embedded in a function by the executors. ESM and top-level
    // await are intentionally rejected because they cannot run there.
    program = parse(code, { ecmaVersion: "latest", sourceType: "script" });
  } catch (error) {
    return {
      valid: false,
      errors: [error instanceof Error ? error.message : "Invalid JavaScript"],
    };
  }
  if (!triggers.length) errors.push("Choose at least one supported trigger.");

  const exportedFunctions = new Set<string>();
  for (const statement of program.body) {
    if (statement.type !== "ExpressionStatement") continue;
    const assignment = statement.expression;
    if (
      assignment.type !== "AssignmentExpression" ||
      assignment.operator !== "="
    )
      continue;
    const { left, right } = assignment;
    if (
      left.type !== "MemberExpression" ||
      left.object.type !== "Identifier" ||
      left.object.name !== "exports"
    )
      continue;
    const name = memberName(left);
    const callable =
      right.type === "ArrowFunctionExpression" ||
      right.type === "FunctionExpression" ||
      (right.type === "Identifier" &&
        program.body.some(
          (node) =>
            (node.type === "FunctionDeclaration" &&
              node.id?.name === right.name) ||
            (node.type === "VariableDeclaration" &&
              node.declarations.some(
                (declaration) =>
                  declaration.id.type === "Identifier" &&
                  declaration.id.name === right.name &&
                  (declaration.init?.type === "ArrowFunctionExpression" ||
                    declaration.init?.type === "FunctionExpression"),
              )),
        ));
    if (name && callable) exportedFunctions.add(name);
  }

  for (const { id } of triggers) {
    const triggerId = normalizeActionTrigger(id);
    const handler = Object.hasOwn(TRIGGER_FUNCTION_NAMES, triggerId)
      ? TRIGGER_FUNCTION_NAMES[triggerId]
      : undefined;
    if (!handler) {
      errors.push(`Unsupported trigger: ${id}`);
      continue;
    }
    if (!exportedFunctions.has(handler)) {
      errors.push(`Define exports.${handler} as a function for ${id}.`);
    }
    const shape = TRIGGER_API_SHAPES[triggerId] ?? {};
    walk(program, (node) => {
      if (node.type !== "CallExpression") return;
      const callee = node.callee;
      if (
        callee.type !== "MemberExpression" ||
        callee.object.type !== "MemberExpression"
      )
        return;
      const namespace = callee.object;
      if (
        namespace.object.type !== "Identifier" ||
        namespace.object.name !== "api"
      )
        return;
      const namespaceName = memberName(namespace);
      const method = memberName(callee);
      if (
        namespaceName &&
        method &&
        (!Object.hasOwn(shape, namespaceName) ||
          !shape[namespaceName]?.includes(method))
      ) {
        errors.push(`api.${namespaceName}.${method} is unavailable for ${id}.`);
      }
    });
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

function memberName(node: MemberExpression): string | undefined {
  if (!node.computed && node.property.type === "Identifier")
    return node.property.name;
  if (
    node.computed &&
    node.property.type === "Literal" &&
    typeof node.property.value === "string"
  )
    return node.property.value;
  return undefined;
}

function walk(node: AnyNode, visit: (node: AnyNode) => void): void {
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        if (
          child &&
          typeof child === "object" &&
          typeof child.type === "string"
        )
          walk(child, visit);
      }
    } else if (
      value &&
      typeof value === "object" &&
      "type" in value &&
      typeof value.type === "string"
    ) {
      walk(value as AnyNode, visit);
    }
  }
}

export function requireVerifiedAction(
  code: string,
  triggers: readonly { id: string }[] = [],
): void {
  const result = verifyActionCode(code, triggers);
  if (!result.valid) {
    throw managementError(
      400,
      `Action verification failed: ${result.errors.join(" ")}`,
      "action_verification_failed",
    );
  }
}
