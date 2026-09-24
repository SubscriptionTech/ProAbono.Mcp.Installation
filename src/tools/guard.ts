/**
 * Turns a failed API call into a tool answer the developer can act on.
 *
 * The API's own error code is kept: it is what the documentation and the troubleshooting guide are
 * indexed on. Three codes get an explanation rather than a bare message, because their wording does
 * not say what to do about them.
 */
import { ProAbonoApiError } from "../api/errors.js";
import { failure, type ToolResult } from "./context.js";

const ACTIONABLE: Record<string, string> = {
  "Error.Api.Usage.NoneMatching":
    "No running subscription of this customer carries that Feature. Check the customer's " +
    "subscriptions, and that the offer behind them carries the Feature.",
  "Error.Customer.PaymentSettings.Missing":
    "The customer has no payment method. Send them through the Customer Portal to add one before " +
    "retrying a billable change.",
  "Error.Customer.Anonymize.HasDueInvoices":
    "The customer still has at least one due invoice, and ProAbono will not erase a customer who " +
    "owes something -- nothing was anonymized. Settle or cancel what is outstanding, then retry.",
  "Error.Customer.Billing.CappingReached":
    "The customer has too many outstanding payments; ProAbono is refusing further billable changes " +
    "until that clears.",
};

export async function guard(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ProAbonoApiError) {
      const advice = error.code === undefined ? undefined : ACTIONABLE[error.code];
      return failure(advice === undefined ? error.describe() : `${error.describe()}\n\n${advice}`);
    }
    return failure(error instanceof Error ? error.message : String(error));
  }
}
