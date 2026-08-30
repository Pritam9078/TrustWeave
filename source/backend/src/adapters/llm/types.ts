/** Structured action proposal. This is the ONLY shape the LLM may emit; free-form text
 *  never reaches a domain service. */
export interface ProposedAction {
  actionType: "CREATE_PAYMENT" | "TRANSFER_ASSET" | "LOOKUP" | "NONE";
  merchant?: string | null;
  amount?: number | null;
  currency?: string | null;
  invoiceRef?: string | null;
  assetId?: string | null;
  newOwnerDid?: string | null;
  purpose: string;
  evidenceIds: string[];
  confidence: number;
  uncertainty?: string | null;
  requestedTool?: string | null;
}

export interface LLMProvider {
  readonly name: string;
  proposeAction(params: {
    instruction: string;
    evidence: { id: string; title: string; content: string }[];
    allowedTools: string[];
  }): Promise<ProposedAction>;
  health(): Promise<{ ok: boolean; detail: string }>;
}
