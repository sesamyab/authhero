import { HTTPException } from "hono/http-exception";

/**
 * Flow-control error thrown by pre-user-registration hooks when submitted
 * signup data fails custom validation.
 */
export class SignupValidationError extends HTTPException {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(400, {
      message,
      res: new Response(JSON.stringify({ message }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    });
    this.name = SignupValidationError.name;
    this.code = code;
  }
}
