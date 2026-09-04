import type { CallRecord, CallStatus } from "./types.js";

const TERMINAL: ReadonlySet<CallStatus> = new Set(["completed", "failed", "no_answer", "busy"]);

export class CallStore {
  private readonly byId = new Map<string, CallRecord>();
  private readonly byControlId = new Map<string, string>();
  private readonly seenEvents = new Set<string>();

  create(call: CallRecord): CallRecord {
    this.byId.set(call.id, call);
    if (call.telnyx.callControlId) this.byControlId.set(call.telnyx.callControlId, call.id);
    return call;
  }

  get(id: string): CallRecord | undefined {
    return this.byId.get(id);
  }

  getByControlId(callControlId: string): CallRecord | undefined {
    const id = this.byControlId.get(callControlId);
    return id ? this.byId.get(id) : undefined;
  }

  indexControlId(call: CallRecord, callControlId: string): void {
    call.telnyx.callControlId = callControlId;
    this.byControlId.set(callControlId, call.id);
  }

  consumeEvent(eventId: string | undefined): boolean {
    if (!eventId) return false;
    if (this.seenEvents.has(eventId)) return true;
    this.seenEvents.add(eventId);
    if (this.seenEvents.size > 10_000) {
      const first = this.seenEvents.values().next().value;
      if (first) this.seenEvents.delete(first);
    }
    return false;
  }

  isTerminal(call: CallRecord): boolean {
    return TERMINAL.has(call.status);
  }
}
