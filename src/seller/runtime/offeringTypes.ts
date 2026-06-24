export interface ExecuteJobResult {
  deliverable: string | { type: string; value: unknown };
  payableDetail?: { amount: number; tokenAddress: string };
}

export type ValidationResult = boolean | { valid: boolean; reason?: string };

export interface PrepareAgreementResult {
  extraMessage?: string;
  extra?: Record<string, any>;
  budgetOverride?: number;
}

export interface OfferingHandlers {
  executeJob: (request: Record<string, any>) => Promise<ExecuteJobResult>;
  validateRequirements?: (request: Record<string, any>) => ValidationResult;
  prepareAgreement?: (
    request: Record<string, any>
  ) => Promise<PrepareAgreementResult> | PrepareAgreementResult;
}
