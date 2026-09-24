/**
 * The Customer group of spec section 4: one tool per Live API operation a priority journey reaches.
 *
 * Three things here are load-bearing and are asserted by the test suite rather than left to the
 * caller:
 *
 *  - **`POST /v1/Customer` is an upsert on `ReferenceCustomer`.** One tool carries create and
 *    update, and its description says so, so it is never passed over by a model that has an
 *    existing reference in hand.
 *  - **`POST /v1/CustomerSettingsPayment` is a partial update**, and three tools write to it. Each
 *    sends its own field and nothing else: a tool that echoed back the fields it had read would
 *    silently overwrite the other two.
 *  - **`anonymize_customer` cannot be undone.** It is the only such tool in the server. It erases
 *    the personal data and keeps the invoices and the subscription history, which is what a GDPR
 *    erasure asks of a billing system -- and why it destroys no billing history.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { json, type ToolContext, type ToolResult } from "./context.js";
import { guard } from "./guard.js";

const metadata = z
  .record(z.string(), z.string())
  .optional()
  .describe("Free key/value pairs stored on the record. At most 5 keys, 450 characters per value.");

/**
 * The manual payment methods `POST /v1/CustomerSettingsPayment` accepts. `Card` and `DirectDebit`
 * are driven by the payment gateway and the endpoint refuses them, so they are never offered.
 */
const MANUAL_PAYMENT_METHODS = ["ExternalBank", "ExternalCash", "ExternalCheck", "ExternalOther"] as const;

export function registerCustomerTools(server: McpServer, context: ToolContext): void {
  const { client, configuration } = context;

  server.registerTool(
    "get_customer",
    {
      title: "Retrieve one customer",
      description:
        "Retrieves a ProAbono customer by the reference shared with the merchant's application " +
        "(ReferenceCustomer), with the Links its hosted pages are opened from. Read-only. Use it to " +
        "check whether a logged-in user already exists as a ProAbono customer.",
      inputSchema: {
        customer_ref: z.string().min(1).describe("The customer's shared reference."),
        offer_ref: z
          .string()
          .optional()
          .describe("When given, the Links include a hosted subscription page for that offer."),
      },
    },
    async ({ customer_ref, offer_ref }): Promise<ToolResult> =>
      guard(async () =>
        json(
          await client.get("/v1/Customer", {
            ReferenceCustomer: customer_ref,
            ReferenceOffer: offer_ref,
          }),
        ),
      ),
  );

  server.registerTool(
    "create_update_customer",
    {
      title: "Create or update a ProAbono customer (write)",
      description:
        "WRITE. Creates a ProAbono customer in the configured Segment, or updates it when one " +
        "already carries that reference -- the endpoint is an upsert keyed on ReferenceCustomer, so " +
        "this one tool covers both and never fails because the customer exists. Use it for the " +
        "first provisioning at sign-up or first login, which is the recommended path (the hosted " +
        "pages and the rights read both need the customer to exist), and for every later change. " +
        "Only the fields passed are written. Do not pass a field the merchant's application is not " +
        "the authority for: the hosted pages let customers edit their own name and language, and " +
        "this overwrites what they set.",
      inputSchema: {
        customer_ref: z
          .string()
          .min(1)
          .describe("Shared reference, derived from the application's user identifier."),
        email: z.string().optional().describe("The customer's email address."),
        name: z.string().optional().describe("Internal name, shown in the BackOffice."),
        language: z.string().optional().describe("ISO 639 language code, e.g. \"en\"."),
        metadata,
      },
    },
    async ({ customer_ref, email, name, language, metadata: meta }): Promise<ToolResult> =>
      guard(async () =>
        json(
          await client.post("/v1/Customer", {
            body: {
              ReferenceCustomer: customer_ref,
              ReferenceSegment: configuration.segmentRef,
              Email: email,
              Name: name,
              Language: language,
              Metadata: meta,
            },
          }),
        ),
      ),
  );

  server.registerTool(
    "get_billing_address",
    {
      title: "Read a customer's billing address",
      description:
        "Reads the full billing address of a ProAbono customer: company, name, both address lines, " +
        "postcode, city, country, region, phone and tax identifier. Read-only. This is the address " +
        "invoices are issued against, and the tax identifier is what the VAT treatment is derived " +
        "from -- read it before deciding whether an update is needed.",
      inputSchema: {
        customer_ref: z.string().min(1).describe("The customer's shared reference."),
      },
    },
    async ({ customer_ref }): Promise<ToolResult> =>
      guard(async () =>
        json(await client.get("/v1/CustomerAddressBilling", { ReferenceCustomer: customer_ref })),
      ),
  );

  server.registerTool(
    "update_billing_address",
    {
      title: "Update a customer's billing address (write)",
      description:
        "WRITE. Updates the billing address of a ProAbono customer. Only the fields passed are " +
        "changed. The address is what invoices are issued against, and the tax identifier is what " +
        "VAT treatment is derived from, so it must be the customer's own data -- never a placeholder.",
      inputSchema: {
        customer_ref: z.string().min(1).describe("Shared reference of the customer."),
        company: z.string().optional(),
        first_name: z.string().optional(),
        last_name: z.string().optional(),
        address_line1: z.string().optional(),
        address_line2: z.string().optional(),
        zip_code: z.string().optional(),
        city: z.string().optional(),
        country: z.string().optional().describe("ISO 3166-1 alpha-2 country code, e.g. \"FR\"."),
        region: z.string().optional().describe("Region, state or province."),
        phone: z.string().optional(),
        tax_information: z.string().optional().describe("VAT or other tax identifier."),
      },
    },
    async (input): Promise<ToolResult> =>
      guard(async () =>
        json(
          await client.post("/v1/CustomerAddressBilling", {
            query: { ReferenceCustomer: input.customer_ref },
            body: {
              Company: input.company,
              FirstName: input.first_name,
              LastName: input.last_name,
              AddressLine1: input.address_line1,
              AddressLine2: input.address_line2,
              ZipCode: input.zip_code,
              City: input.city,
              Country: input.country,
              Region: input.region,
              Phone: input.phone,
              TaxInformation: input.tax_information,
            },
          }),
        ),
      ),
  );

  server.registerTool(
    "get_payment_settings",
    {
      title: "Read a customer's payment settings",
      description:
        "Reads the payment settings of a ProAbono customer in one call: the active payment type, " +
        "the billing mode, whether the customer is grey-listed, the note printed on upcoming " +
        "invoices, and the date of the next billing. Read-only. These are the settings that " +
        "set_payment_method, set_invoice_note and set_next_billing_date each write one field of.",
      inputSchema: {
        customer_ref: z.string().min(1).describe("The customer's shared reference."),
      },
    },
    async ({ customer_ref }): Promise<ToolResult> =>
      guard(async () =>
        json(await client.get("/v1/CustomerSettingsPayment", { ReferenceCustomer: customer_ref })),
      ),
  );

  server.registerTool(
    "set_next_billing_date",
    {
      title: "Set a customer's next billing date (write)",
      description:
        "WRITE. Sets the date of the next billing of a ProAbono customer, and changes nothing else " +
        "about their payment settings. Use it to align a customer's billing on a date the merchant " +
        "chose -- a common anniversary, or the end of a negotiated period. Read the current value " +
        "with get_payment_settings first: moving the date forward skips a period rather than " +
        "compressing it.",
      inputSchema: {
        customer_ref: z.string().min(1).describe("Shared reference of the customer."),
        date_next_billing: z
          .string()
          .min(1)
          .describe("The next billing date, ISO 8601, e.g. \"2026-10-01T00:00:00Z\"."),
      },
    },
    async ({ customer_ref, date_next_billing }): Promise<ToolResult> =>
      guard(async () =>
        json(
          await client.post("/v1/CustomerSettingsPayment", {
            query: { ReferenceCustomer: customer_ref },
            // One field and one only: the endpoint is a partial update, and sending the fields this
            // tool did not ask for would overwrite what the other two tools wrote.
            body: { DateNextBilling: date_next_billing },
          }),
        ),
      ),
  );

  server.registerTool(
    "set_invoice_note",
    {
      title: "Set the note printed on a customer's invoices (write)",
      description:
        "WRITE. Sets the note printed at the bottom of every upcoming invoice of a ProAbono " +
        "customer, and changes nothing else about their payment settings. Use it for a purchase " +
        "order number, a cost centre, or anything the customer's own accounting needs on the " +
        "document. It applies to invoices issued from now on, never to ones already issued.",
      inputSchema: {
        customer_ref: z.string().min(1).describe("Shared reference of the customer."),
        note: z
          .string()
          .describe(
            "The note to print. The endpoint is a partial update, so the note is only ever " +
              "changed by this call and never by the other two payment-settings tools.",
          ),
      },
    },
    async ({ customer_ref, note }): Promise<ToolResult> =>
      guard(async () =>
        json(
          await client.post("/v1/CustomerSettingsPayment", {
            query: { ReferenceCustomer: customer_ref },
            body: { NoteInvoice: note },
          }),
        ),
      ),
  );

  server.registerTool(
    "set_payment_method",
    {
      title: "Record a manual payment method for a customer (write)",
      description:
        "WRITE. Records the manual payment method a ProAbono customer settles their invoices with " +
        "-- bank transfer, cash, cheque or other -- and changes nothing else about their payment " +
        "settings. Manual methods only: Card and DirectDebit are driven by the payment gateway and " +
        "the endpoint refuses them here, so a customer paying by card is set up through the " +
        "Customer Portal instead, never through this tool.",
      inputSchema: {
        customer_ref: z.string().min(1).describe("Shared reference of the customer."),
        payment_method: z
          .enum(MANUAL_PAYMENT_METHODS)
          .describe(
            "ExternalBank (transfer), ExternalCash, ExternalCheck, or ExternalOther. Card and " +
              "DirectDebit are not accepted here.",
          ),
      },
    },
    async ({ customer_ref, payment_method }): Promise<ToolResult> =>
      guard(async () =>
        json(
          await client.post("/v1/CustomerSettingsPayment", {
            query: { ReferenceCustomer: customer_ref },
            body: { TypePayment: payment_method },
          }),
        ),
      ),
  );

  server.registerTool(
    "anonymize_customer",
    {
      title: "Anonymize a customer, irreversibly (write)",
      description:
        "WRITE, AND IRREVERSIBLE. Erases the personal data of a ProAbono customer -- name and email " +
        "-- and keeps their invoices and their subscription history, which is what a GDPR erasure " +
        "asks of a billing system. There is no de-anonymization: the Live API offers none, and the " +
        "erased values cannot be recovered from ProAbono by any means. This is the only tool in " +
        "this server whose effect cannot be undone. Use it to serve an erasure request, never to " +
        "tidy up test data, and confirm with the developer that this is the customer they mean " +
        "before calling it -- the reference is the only thing identifying them, and a typo " +
        "anonymizes somebody else. ProAbono refuses the call while the customer still has a due " +
        "invoice: settle or cancel what is outstanding first.",
      inputSchema: {
        customer_ref: z
          .string()
          .min(1)
          .describe("Shared reference of the customer whose personal data is erased."),
      },
    },
    async ({ customer_ref }): Promise<ToolResult> =>
      guard(async () =>
        json({
          anonymized: await client.post("/v1/Customer/Anonymization", {
            query: { ReferenceCustomer: customer_ref },
          }),
          note:
            "The personal data of this customer is erased and cannot be restored. Their invoices " +
            "and subscription history are kept, and their subscriptions keep running: " +
            "anonymization is not a termination.",
        }),
      ),
  );
}
