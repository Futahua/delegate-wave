import { ControlError } from "./errors.js";

export class ControlClient {
  constructor({
    baseUrl = process.env.DELEGATE_WAVE_CONTROL_URL || "http://127.0.0.1:47321",
    token = process.env.DELEGATE_WAVE_CONTROL_TOKEN,
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
  }

  async request(method, path, { body, requestId } = {}) {
    if (!this.token) throw new ControlError("CONTROL_TOKEN_REQUIRED", "DELEGATE_WAVE_CONTROL_TOKEN is required", 401);
    const headers = { authorization: `Bearer ${this.token}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (requestId) headers["x-request-id"] = requestId;
    let response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new ControlError("CONTROL_API_UNAVAILABLE", `Control API unavailable at ${this.baseUrl}: ${error.message}`, 503);
    }
    let envelope;
    try { envelope = await response.json(); } catch { throw new ControlError("INVALID_CONTROL_RESPONSE", "Control API returned invalid JSON", 502); }
    if (!response.ok || !envelope.ok) {
      throw new ControlError(envelope.error?.code || "CONTROL_REQUEST_FAILED", envelope.error?.message || `HTTP ${response.status}`, response.status, envelope.error?.details);
    }
    return envelope.result;
  }

  get(path) { return this.request("GET", path); }
  post(path, body, requestId) { return this.request("POST", path, { body, requestId }); }
}
