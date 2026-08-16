/**
 * Starting a paid subscription — the half `billing.ts` had no counterpart for.
 *
 * `billing.ts` verifies deliveries and moves a tier, and its lookup is *by
 * customer id*. Nothing in `src/` ever produced a customer id, so a real,
 * correctly-signed webhook resolved no owner and the tier never moved. The
 * missing piece was not the webhook; it was the moment before it — creating the
 * vendor's customer, binding it to the account, and only then sending the person
 * to pay.
 *
 * **The customer is created before the session, deliberately.** A checkout
 * session with `customer_creation` mints its customer at *completion*, so the id
 * does not exist when the user is redirected and the first delivery to arrive is
 * one nothing can attribute. Creating the customer first means the account is
 * bound before the user can possibly return, and `checkout.session.completed`
 * has an owner whichever order the vendor sends things in.
 *
 * **No SDK, and no hostname in this file.** `billing.ts` verifies signatures
 * with thirty lines of HMAC rather than importing a client to do arithmetic;
 * this is the same argument for the two calls it needs. The API base arrives as
 * configuration rather than a literal — a hostname written here would be a
 * vendor named in the code and not in R10's register, which is exactly the drift
 * `src/register/completeness.ts` scans for.
 *
 * **The secret key never leaves this module and is never echoed.** What the
 * caller receives is a customer id and a redirect URL, both of which are
 * publishable; a vendor error is reported as a reason, never as a body that
 * might quote the request it was sent.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface CheckoutRequest {
  /** Carried to the vendor as metadata, so a support question has an answer. */
  readonly accountId: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
}

export type CheckoutStart =
  | { readonly ok: true; readonly customerId: string; readonly url: string }
  | { readonly ok: false; readonly reason: 'vendor_refused' | 'vendor_unreachable' | 'malformed_response' };

/**
 * The port the web app declares. A port for the reason `ConnectorVendor` is one:
 * the app must be able to run — and be tested — on a deployment that has no
 * billing vendor configured, and an absent port disables the route rather than
 * faking a redirect to somewhere that takes no money.
 */
export interface CheckoutPort {
  start(request: CheckoutRequest): Promise<CheckoutStart>;
}

export interface StripeCheckoutOptions {
  /** e.g. the vendor's API origin. Configuration, never a literal here. */
  readonly apiBase: string;
  readonly secretKey: string;
  /** The price the subscription is for. One plan; alpha has exactly one. */
  readonly priceId: string;
  readonly fetchImpl?: FetchLike;
}

const CUSTOMERS_PATH = '/v1/customers';
const SESSIONS_PATH = '/v1/checkout/sessions';

export function createStripeCheckout(options: StripeCheckoutOptions): CheckoutPort {
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));

  async function post(path: string, form: Record<string, string>): Promise<Record<string, unknown> | null> {
    let response: Response;
    try {
      response = await fetchImpl(`${options.apiBase}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.secretKey}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(form).toString(),
      });
    } catch {
      // The network, not the vendor. Distinguished by the caller's reason so an
      // operator can tell "they said no" from "we could not ask".
      return null;
    }
    if (!response.ok) return null;
    try {
      const parsed: unknown = await response.json();
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  return {
    async start(request: CheckoutRequest): Promise<CheckoutStart> {
      const customer = await post(CUSTOMERS_PATH, {
        // The account id, so a vendor-side question can be answered without a
        // second lookup. No email: the address is the account's, and sending it
        // here would widen what the vendor holds beyond what R12's register
        // entry says it holds.
        'metadata[account_id]': request.accountId,
      });
      if (customer === null) return { ok: false, reason: 'vendor_unreachable' };

      const customerId = customer['id'];
      if (typeof customerId !== 'string' || customerId.length === 0) {
        return { ok: false, reason: 'malformed_response' };
      }

      const session = await post(SESSIONS_PATH, {
        mode: 'subscription',
        customer: customerId,
        'line_items[0][price]': options.priceId,
        'line_items[0][quantity]': '1',
        client_reference_id: request.accountId,
        success_url: request.successUrl,
        cancel_url: request.cancelUrl,
      });
      if (session === null) return { ok: false, reason: 'vendor_refused' };

      const url = session['url'];
      if (typeof url !== 'string' || url.length === 0) return { ok: false, reason: 'malformed_response' };

      return { ok: true, customerId, url };
    },
  };
}
