/**
 * The Invoicing and balance group of spec section 4.
 *
 * Three decisions here are settled and are not re-derived per call:
 *
 *  - **The PDF URL is read from `Links`, by the `insite-related-invoice` `rel`**, and is never
 *    rebuilt from the invoice number. The href carries an encrypted query; a URL assembled from
 *    the number is not a valid one, and a developer handed it finds out in production.
 *  - **`TypeCredit` tells a credit note from a debit invoice, by its absence.** There is no flag
 *    and no separate endpoint: `get_invoice` and `get_credit_note` read the same operations and
 *    differ only in which document the developer meant. Neither can enforce the split server-side,
 *    so each reports the other kind rather than pretending.
 *  - **`list_invoices` is one tool**, not two. `GET /v1/Invoices` returns both kinds together and
 *    offers no filter, so a second tool could only filter after the fetch -- and would then report
 *    a count that is not the answer to the question asked.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { failure, json, type ToolContext, type ToolResult } from "./context.js";
import { guard } from "./guard.js";

/**
 * The `rel`s the invoice PDF is published under. Never rebuild the URL from the invoice number.
 *
 * Two spellings, and that is not defensive programming. The contract documents
 * `insite-related-invoice`, and a live account answered `related-invoice` on 2026-09-24 -- on an
 * invoice that carried `insite-charge` and `insite-collection-invoice` under their documented
 * names. Looking for the documented spelling alone meant never finding the PDF of a real invoice
 * and reporting "this document publishes no PDF link" about one that does. Both are accepted, the
 * documented one first, until the contract and the API agree.
 */
const PDF_RELS = ["insite-related-invoice", "related-invoice"] as const;

interface Link {
  readonly rel?: string;
  readonly href?: string;
  readonly type?: string;
}

interface InvoiceDocument {
  readonly Id?: number;
  readonly FullNumber?: string | null;
  readonly TypeCredit?: string | null;
  readonly Reason?: string | null;
  readonly Links?: readonly Link[];
}

/** The PDF href, or undefined when the document does not publish one. Never fabricated. */
function pdfUrl(document: InvoiceDocument): string | undefined {
  for (const rel of PDF_RELS) {
    const link = (document.Links ?? []).find((candidate) => candidate.rel === rel);
    if (typeof link?.href === "string") return link.href;
  }
  return undefined;
}

/** A credit note is an invoice carrying `TypeCredit`; its absence is what identifies a debit one. */
function isCreditNote(document: InvoiceDocument): boolean {
  return typeof document.TypeCredit === "string" && document.TypeCredit.length > 0;
}

function describeDocument(document: InvoiceDocument): string {
  const name = document.FullNumber ?? (document.Id === undefined ? "this document" : `#${document.Id}`);
  return name;
}

const noPdfNote =
  `This document publishes no PDF link -- neither "${PDF_RELS[0]}", which the contract documents, ` +
  `nor "${PDF_RELS[1]}", which a live account was observed to answer with. A Draft invoice has ` +
  `none yet. Do not build a URL from the invoice number: the real one carries an encrypted query ` +
  `and cannot be reconstructed.`;

export function registerInvoicingTools(server: McpServer, context: ToolContext): void {
  const { client } = context;

  /**
   * Reads one billing document by identifier or by full number. Shared by both read tools.
   *
   * Discriminated rather than returning `InvoiceDocument | string`: a union on the payload type
   * would make a response that happens to be a string indistinguishable from a rejection here.
   */
  async function readDocument(
    invoiceId: number | undefined,
    fullNumber: string | undefined,
  ): Promise<{ ok: true; document: InvoiceDocument } | { ok: false; reason: string }> {
    if ((invoiceId === undefined) === (fullNumber === undefined)) {
      return {
        ok: false,
        reason:
          "Pass exactly one of invoice_id or full_number. The internal identifier and the printed " +
          "number are two ways to the same document, and the Live API has one operation for each.",
      };
    }

    const document =
      invoiceId !== undefined
        ? await client.get<InvoiceDocument>("/v1/Invoice/{id}", { id: invoiceId })
        : await client.get<InvoiceDocument>("/v1/Invoice", { FullNumber: fullNumber });

    return { ok: true, document };
  }

  server.registerTool(
    "get_invoice",
    {
      title: "Retrieve a debit invoice",
      description:
        "Retrieves one ProAbono debit invoice with all its detail -- status, amounts, dates, " +
        "payment method, the note printed on it -- and its PDF URL, taken from the document's own " +
        "Links. Read-only. Identify it by internal identifier or by full number; pass one, not " +
        "both. A credit note is a different document: use get_credit_note for it. If the identifier " +
        "turns out to name one, this tool says so rather than returning it as an invoice.",
      inputSchema: {
        invoice_id: z.number().int().optional().describe("Internal identifier of the invoice (Id)."),
        full_number: z
          .string()
          .optional()
          .describe("Full invoice number as printed, e.g. \"S-7.00001673\"."),
      },
    },
    async ({ invoice_id, full_number }): Promise<ToolResult> =>
      guard(async () => {
        const read = await readDocument(invoice_id, full_number);
        if (!read.ok) return failure(read.reason);
        const document = read.document;

        if (isCreditNote(document)) {
          return failure(
            `${describeDocument(document)} is a credit note, not a debit invoice: it carries ` +
              `TypeCredit "${document.TypeCredit}". Read it with get_credit_note, which reports its ` +
              `Reason as well. The Live API serves both kinds from the same endpoint, so this tool ` +
              `cannot refuse it server-side -- it is refused here instead of being returned as ` +
              `something it is not.`,
          );
        }

        const pdf = pdfUrl(document);
        return json({
          invoice: document,
          pdf_url: pdf,
          ...(pdf === undefined ? { pdf_note: noPdfNote } : {}),
        });
      }),
  );

  server.registerTool(
    "get_credit_note",
    {
      title: "Retrieve a credit note",
      description:
        "Retrieves one ProAbono credit note with all its detail: its TypeCredit -- Refund when a " +
        "paid invoice was given back, Voiding when one was cancelled before payment -- the Reason " +
        "it was issued for, its amounts and its PDF URL, taken from the document's own Links. " +
        "Read-only. Identify it by internal identifier or by full number; pass one, not both. A " +
        "credit note is an invoice carrying TypeCredit, and the Live API serves both kinds from the " +
        "same endpoint: if the identifier names a debit invoice, this tool says so rather than " +
        "returning it as a credit note. Use get_invoice for a debit invoice.",
      inputSchema: {
        invoice_id: z
          .number()
          .int()
          .optional()
          .describe("Internal identifier of the credit note (Id)."),
        full_number: z.string().optional().describe("Full number of the credit note as printed."),
      },
    },
    async ({ invoice_id, full_number }): Promise<ToolResult> =>
      guard(async () => {
        const read = await readDocument(invoice_id, full_number);
        if (!read.ok) return failure(read.reason);
        const document = read.document;

        if (!isCreditNote(document)) {
          return failure(
            `${describeDocument(document)} is a debit invoice, not a credit note: it carries no ` +
              `TypeCredit, and that absence is what identifies a debit invoice. Read it with ` +
              `get_invoice. The Live API serves both kinds from the same endpoint, so this tool ` +
              `cannot refuse it server-side -- it is refused here instead of being returned as ` +
              `something it is not.`,
          );
        }

        const pdf = pdfUrl(document);
        return json({
          credit_note: document,
          type_credit: document.TypeCredit,
          reason: document.Reason ?? null,
          pdf_url: pdf,
          ...(pdf === undefined ? { pdf_note: noPdfNote } : {}),
        });
      }),
  );

  server.registerTool(
    "list_invoices",
    {
      title: "List a customer's billing documents",
      description:
        "Lists the billing documents of a ProAbono customer: debit invoices and credit notes " +
        "together, as the Live API returns them, with TypeCredit telling the two apart -- present " +
        "means a credit note, absent means a debit invoice. Read-only. There is no kind filter, " +
        "here or in the API: filter the returned list yourself if only one kind is wanted, and say " +
        "so in the answer, because the count reported here is the customer's full document history. " +
        "Reads every page.",
      inputSchema: {
        customer_ref: z.string().optional().describe("Restrict to this customer's documents."),
        subscription_id: z
          .number()
          .int()
          .optional()
          .describe("Restrict to the documents of one subscription."),
      },
    },
    async ({ customer_ref, subscription_id }): Promise<ToolResult> =>
      guard(async () => {
        const documents = await client.listAll<InvoiceDocument>("/v1/Invoices", {
          ReferenceCustomer: customer_ref,
          IdSubscription: subscription_id,
        });
        const creditNotes = documents.filter(isCreditNote).length;

        return json({
          count: documents.length,
          debit_invoices: documents.length - creditNotes,
          credit_notes: creditNotes,
          documents,
          note:
            documents.length === 0
              ? "No billing document came back. A customer who has never been billed has none -- " +
                "check list_subscriptions before concluding anything is broken."
              : "Both kinds are in this list. TypeCredit is present on credit notes and absent on " +
                "debit invoices; this list is not filtered on it and cannot be.",
        });
      }),
  );

  server.registerTool(
    "create_balance_line",
    {
      title: "Add a line to a customer's balance (write)",
      description:
        "WRITE. Creates a line in the balance of a ProAbono customer: a debit when the amount is " +
        "positive, a credit when it is negative. The amount is in cents, in the Segment's currency. " +
        "This does not invoice anything -- it puts an amount in the balance, waiting. bill_customer " +
        "is what turns the balance into an invoice, and the pair is only useful in that order. Use " +
        "it for a one-off charge or a goodwill credit that the catalogue does not cover.",
      inputSchema: {
        customer_ref: z.string().min(1).describe("Shared reference of the customer."),
        amount: z
          .number()
          .int()
          .describe("Amount in cents. Positive for a debit, negative for a credit."),
        label: z.string().optional().describe("Label of the line, shown on the invoice."),
        quantity: z.number().int().optional().describe("Quantity, when the line represents units."),
        key_charge: z
          .string()
          .optional()
          .describe("Related charge key, which is what the tax treatment is derived from."),
        subscription_id: z
          .number()
          .int()
          .optional()
          .describe("Internal identifier of the subscription this line relates to."),
        date: z
          .string()
          .optional()
          .describe("Value date of a one-off entry, ISO 8601. Exclusive with the period dates."),
        period_start: z
          .string()
          .optional()
          .describe("Period start of a period entry, ISO 8601. Exclusive with date."),
        period_end: z
          .string()
          .optional()
          .describe("Period end of a period entry, ISO 8601. Exclusive with date."),
        ensure_billable: z
          .boolean()
          .optional()
          .describe("Check the customer can be billed before creating the line."),
      },
    },
    async (input): Promise<ToolResult> =>
      guard(async () => {
        const hasPeriod = input.period_start !== undefined || input.period_end !== undefined;
        if (input.date !== undefined && hasPeriod) {
          return failure(
            "Pass either date, for a one-off entry, or period_start and period_end, for an entry " +
              "covering a period -- the Live API treats them as mutually exclusive.",
          );
        }

        return json(
          await client.post("/v1/BalanceLine", {
            query: { EnsureBillable: input.ensure_billable },
            body: {
              ReferenceCustomer: input.customer_ref,
              Amount: input.amount,
              Label: input.label,
              Quantity: input.quantity,
              KeyCharge: input.key_charge,
              IdSubscription: input.subscription_id,
              Date: input.date,
              DatePeriodStart: input.period_start,
              DatePeriodEnd: input.period_end,
            },
          }),
        );
      }),
  );

  server.registerTool(
    "bill_customer",
    {
      title: "Invoice a customer's balance (write)",
      description:
        "WRITE. Creates an invoice from the lines currently sitting in a ProAbono customer's " +
        "balance, and returns it. Whatever is in the balance is what gets invoiced, so " +
        "create_balance_line is what decides the amount and runs first -- billing an empty balance " +
        "invoices nothing. The invoice is issued for real and, for a customer on an automated " +
        "payment method, a charge is attempted immediately. Read it back afterwards with " +
        "get_invoice, whose answer carries the PDF URL.",
      inputSchema: {
        customer_ref: z.string().min(1).describe("Shared reference of the customer to invoice."),
        note: z
          .string()
          .optional()
          .describe("Note printed at the bottom of this invoice, above the customer service section."),
        ensure_billable: z
          .boolean()
          .optional()
          .describe("Force the payment-information check even when the amount is zero."),
        force_offline: z
          .boolean()
          .optional()
          .describe("Issue an offline invoice even for a customer on card or direct debit."),
        period_start: z
          .string()
          .optional()
          .describe("Ignore balance lines before this date, ISO 8601."),
        period_end: z
          .string()
          .optional()
          .describe("Ignore balance lines after this date, ISO 8601."),
      },
    },
    async (input): Promise<ToolResult> =>
      guard(async () => {
        const invoice = await client.post<InvoiceDocument>("/v1/Billing/Customer", {
          body: {
            ReferenceCustomer: input.customer_ref,
            NoteLocalized: input.note,
            EnsureBillable: input.ensure_billable,
            ForceOffline: input.force_offline,
            DateStart: input.period_start,
            DateEnd: input.period_end,
          },
        });

        const pdf = pdfUrl(invoice);
        return json({
          invoice,
          pdf_url: pdf,
          ...(pdf === undefined ? { pdf_note: noPdfNote } : {}),
        });
      }),
  );
}
