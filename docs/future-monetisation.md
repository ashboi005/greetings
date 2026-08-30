# Future monetisation and limits

Two things deliberately left out of the first release, recorded here so the decisions behind them
are not lost and so the groundwork already laid is visible.

Neither is built. Nothing in the code today enforces a limit or draws a watermark. What follows is
the reasoning, the hooks that already exist, and the honest constraints.

---

## 1. Upload limits and subscriptions

### Where things stand

A user may save unlimited designs, each with one uploaded image, and **there is no way to delete
one**. That is intentional, not an omission. Storage therefore only ever grows, per user, forever.

The missing delete is the precondition for the whole idea. A cap that a user can duck under by
deleting old work is not a cap — it is an inconvenience. Because nothing can be removed, "you have
saved 20 designs" is a durable fact, and a limit built on it means something.

### What a limit would look like

The shape is already there: `user_designs` is one row per design, scoped by `user_id`, so a count is
a single indexed query against `user_designs_user_idx`. A tier check would sit in
`POST /v1/me/designs` — the one place a design comes into being — and nowhere else.

What would need building:

- A subscription state per user. Not a boolean: it needs an expiry, and it needs to survive the
  payment provider being unreachable, so a cached "entitled until" timestamp rather than a live
  lookup on the request path.
- A payment integration. In India that most likely means Razorpay, or the store billing SDKs if the
  app sells it as an in-app purchase — and note that Apple and Google both require store billing for
  digital goods consumed in the app, which is a 15–30% cut and a policy constraint, not a choice.
- A grace path for someone whose subscription lapses while over the limit. Deleting their work is
  not an option (there is no delete), so the answer is read-only: they keep everything, they simply
  cannot save more until they are back under the cap or paying again.

### Storage, honestly

Worth sizing before picking a number. At R2's storage pricing, 10,000 users each holding 5 images at
2 MB is roughly 100 GB — around **$1.50/month**. Storage is not the reason to charge; it is
nowhere near expensive enough to justify a paywall on its own.

So set the limit at whatever makes the paid tier feel worth buying, not at whatever covers cost. And
be aware the honest reason for the cap is commercial, because a user who reads the pricing page will
work that out too.

---

## 2. Watermarks

### The intent

No watermarks today. When a paywall arrives: every shared image carries a watermark by default, and
paying removes it.

### The constraint that has to be understood first

**A watermark here will be a nudge, not an enforcement, and the architecture makes that unavoidable.**

Images are composited on the device (spec §16.1) — that is forced by the product, because the user
drags and resizes the overlay before saving and no server can be in the loop on a drag. So the
watermark would be drawn by the same client code the user is running.

And underneath that, the clean original is a public CDN URL. Anyone holding an object key can fetch
the unwatermarked image directly (spec §8), which is the trade knowingly accepted to get cacheable,
resizable images on Indian mobile connections.

Two consequences:

- A modified client, or anyone who reads a key out of an API response, gets a clean image. The
  watermark stops an ordinary user from casually sharing unbranded work. It stops nobody else.
- Removing it is a client-side flag. Whatever gates that flag has to be checked somewhere the client
  cannot simply lie about — which in practice means the app asks the server for entitlement and the
  server records what it granted, so abuse is at least visible after the fact.

### If enforcement ever genuinely matters

The only way to make a watermark real is to serve watermarked bytes from somewhere the user does not
control. That means either a private bucket with per-request signed URLs (giving up CDN caching, the
thing §8 exists to preserve) or a Cloudflare Worker compositing at the edge (keeping caching, but
only for the fixed watermarked variant, and it cannot draw the user's personalised overlay).

Both are real changes to a load-bearing decision. Neither is worth doing for a watermark alone.
Worth doing only if unbranded leakage turns out to cost real money — and that is measurable first:
`download_events.customized` already records how the feature is used.

---

## Not decided

Deliberately open, and each wants its own conversation:

- Whether the paid tier removes ads as well as the watermark. Likely yes — it is the benefit users
  understand fastest — but it trades AdMob revenue for subscription revenue and the exchange rate is
  unknown until both exist.
- Whether designers share in revenue. Every download is already attributed to a designer with a
  region and a timestamp, so the data to pay them exists. The policy does not.
- Pricing, and whether it is a subscription or a one-time unlock. For this audience a small one-time
  payment may convert far better than a recurring charge.
