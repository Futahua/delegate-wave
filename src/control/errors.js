export class ControlError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message);
    this.name = "ControlError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function asControlError(error) {
  if (error instanceof ControlError) return error;
  return new ControlError(error?.code || "COMMAND_FAILED", error?.message || "Command failed", 409);
}
