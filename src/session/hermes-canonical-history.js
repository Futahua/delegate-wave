// Reading what durably happened, without becoming able to change it.
//
// Hermes keeps two transcripts and, until recently, exposed only one of them. `session.history`
// returns the DISPLAY projection, which deliberately drops `display_kind="hidden"` rows so a UI
// never renders machine scaffolding as somebody's speech. A routed wake IS a hidden row, so the
// producer was searching a projection that could not contain its own delivery -- every successful
// wake looked exactly like one that never happened. `session.canonical_history` is the evidence
// projection: the durable lineage, hidden rows included.
//
// WHY THIS IS ITS OWN CLASS.
//
// Not for tidiness. The dangerous operation on this path is CREATING A LIVE HERMES SESSION: a
// resumed session runs the external-turn poller, is eligible to consume events addressed to that
// conversation, and destroys whatever turn it began when its gateway is closed. Reconciliation
// used to do exactly that -- resume, read, close -- which meant the act of LOOKING could take an
// event and then kill it.
//
// So the read path is a class that has no resume, no submit, no create, and cannot grow one by
// accident. Auditing "where does delegate-wave create a live Hermes owner" is now a search with a
// single answer: WakeDeliverer.resumeKick.
//
// Spawning a gateway PROCESS is fine and unavoidable -- it is the JSON-RPC host. A gateway process
// that never resumes a session owns nothing and drains nothing.
import { HermesGateway } from "./hermes-gateway.js";

export class CanonicalHistoryError extends Error {
  constructor(message, { code = null } = {}) {
    super(message);
    this.name = "CanonicalHistoryError";
    this.code = code;
  }
}

export class HermesCanonicalHistory {
  // The gateway is injected for the same reason the deliverer's is: the framing is what every test
  // run should exercise, and Hermes itself is what a deliberate, rare test exercises.
  constructor({ gateway = () => new HermesGateway() } = {}) {
    this.gatewayFactory = gateway;
  }

  // The durable lineage for one STORED session id. Never a runtime handle.
  //
  // Returns rows shaped `{role, text, display_kind?, reasoning?, row_id?}` -- the same fields
  // classification needs and nothing else, so Hermes's internal message representation does not
  // quietly become a contract this project depends on.
  async read(durableSessionId, { profile = null } = {}) {
    const gateway = this.gatewayFactory();
    try {
      await gateway.start();
      const params = { session_id: durableSessionId };
      if (profile) params.profile = profile;
      const answer = await gateway.request("session.canonical_history", params);
      const messages = Array.isArray(answer?.messages) ? answer.messages : [];
      return {
        sessionId: answer?.session_id ?? durableSessionId,
        // Which session in the compression chain actually held the rows. Worth carrying: a wake
        // written before an auto-compression rotation lives on the parent, and knowing the read
        // followed the chain is the difference between "absent" and "looked in the wrong place".
        resolvedSessionId: answer?.resolved_session_id ?? null,
        messages,
      };
    } catch (error) {
      // A refusal that names the session is worth distinguishing from a transport failure: one
      // means the conversation is not there, the other means we could not ask.
      throw new CanonicalHistoryError(
        `canonical history unavailable for ${durableSessionId}: ${error.message}`,
        { code: error.code ?? null },
      );
    } finally {
      await gateway.close();
    }
  }
}
