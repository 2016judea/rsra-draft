# RSRA Draft Tool

**Live:** https://rsra-draft.vercel.app

Drafts a Records Search with Risk Assessment (RSRA) for any property in MSP. That’s the desk-only environmental report the SBA requires on 7(a) and 504 loans over $250,000.

*(Aidan, [Business Prototypes](https://randomaidan.substack.com/p/business-prototypes), 2026-10-12.)*

Type an address in the seven-county Minneapolis–Saint Paul metro, get a **draft RSRA** (SOP 50 10 8, Procedural Notice 5000-866054).

The draft is built for an Environmental Professional (40 CFR 312.10(b)) to review, make the low/high-risk call and sign. It does the records half of the job:

- **Subject property** from the county parcel record (Metropolitan Council regional parcels, seven-county metro): situs address, PIN, owner, use, year built, boundary.
- **Government records**, every list 40 CFR 312.26 names, each searched to the larger of its CFR and ASTM E1527-21 Table 1 distance, measured from the parcel boundary. The lists, distances and citations are data in [`data/lists.json`](data/lists.json).
- **Historical use** back past 1940: USGS historical topographic maps covering the point, Library of Congress Sanborn editions for the city, the county's year built, and links for aerials and city directories with blank fields for the reviewer's findings.
- **A suggested risk call** from three stated rules ([`RULES`](api/_lib/rsra.js)), with the records each rule fired on. The conclusion box is left for the EP.
- Prints clean to PDF; every page carries "DRAFT FOR ENVIRONMENTAL PROFESSIONAL REVIEW".

## The paywall

Any address gets the **free slice**: the subject parcel, the suggested Low/High risk call with how many records each rule fired on, and the count of records on every list at every distance band. The **full draft** for that property is paid: every record by name, address, distance, status and agency link; which records each rule fired on; the historical-use table; the EP signature page; print to PDF.

The full draft never ships as a static file. `example.json` and every `/for/<token>/` page carry the free slice only (`freeSlice` in `api/_lib/rsra.js`; `scripts/build_example.mjs` refuses to write a slice that names a record).

| route | does |
|---|---|
| `GET /api/rsra?address=` | the free slice, CDN-cached |
| `GET /api/rsra?address=&pw=` | the full draft, if the password was bought for this property (or is a comp) |
| `POST /api/checkout` | Stripe embedded Checkout for one property; mints a password bound to that property's county + PIN (`XXXX-XXXX-XXXX`, a nonce + an HMAC of nonce and property under `ACCESS_SECRET`) |
| `POST /api/stripe-webhook` | `checkout.session.completed`: emails the buyer the password and a link (Mailgun), once per session, and Aidan a sale notice |
| `GET /api/session-status` | the return page: paid or not; sends the email if the webhook has not |

Ported from [msp-house-index](https://github.com/2016judea/msp-house-index) (2026-10-11). Vercel env: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `ACCESS_SECRET`, `MAILGUN_API_KEY`, `MAILGUN_DOMAIN`, `MAILGUN_FROM`. Lost password: `python3 scripts/fulfil.py <session_id>`; every sale: `--recent`; a password that opens any property: `--comp-pw <label>`.

The code is MIT and public, so anyone can run the full draft on their own machine. What is sold is the hosted draft, run and ready to print. Git history before 2026-10-15 holds one full example report (`example.json`, 2125 Hennepin Ave E).

Funnel events, sent to both Vercel Analytics and PostHog: `preview_open`, `checkout_open`, `paid`, `unlock`.

`/for/<token>/` pages open on a recipient's own properties: `node scripts/build_for.mjs <recipients.json>` (the recipient lists stay local, in the gitignored `outreach/`).

## Price

**$40 per property, once. A hypothesis, not a fact** (2026-10-15).

One use of the full draft replaces the records search an Environmental Professional would otherwise order. The market prices that at $375 to $415 for a database package and $695 to $850 for a signed RSRA ([a3e](https://a3e.com/environmental-desktop-report-vs-rsra-lenders-need-to-know/), [Compyle](https://www.compyleenvironmental.com/resources/rsra-vs-tsa-vs-phase-1), read 2026-10-15). The draft still needs the EP's signature, so it is worth the database package, about $400. A tenth of that is $40.

msp-house-index at $100 drew 10 checkouts and 0 payments (10/11 to 10/12). This is the test of a price an order of magnitude below what the buyer already pays.

## Sources

| Source | Lists | How |
|---|---|---|
| EPA SEMS (Envirofacts) | NPL, delisted NPL, SEMS, SEMS archive | cached by `scripts/build_sems.py`; archived sites geocoded with the Census batch geocoder |
| EPA ECHO RCRA | CORRACTS, TSDF, LQG/SQG/VSQG | live |
| EPA EMEF / ACRES | federal brownfields | live |
| MPCA Remediation Sites | state Superfund/PLP, site assessment, RCRA remediation, leak sites, VIC, brownfields, emergency response, institutional controls | live, per-project status and dates |
| MPCA What's In My Neighborhood | registered tanks, hazardous waste generators, solid waste | live |
| Met Council parcels | subject boundary | live |
| USGS TNM, Library of Congress | historical topos, Sanborn maps | live |

**Not searched** (no free spatial source): federal IC/EC registries, ERNS, MN Dept. of Agriculture incidents, local city files. The report says so in its own table.

All sources are free and keyless. No data is stored.

## Run

    node --test test/*.test.js      # unit tests (report + paywall)
    python3 scripts/build_sems.py   # refresh the SEMS cache
    node scripts/build_example.mjs  # refresh the example report the page opens on

Deployed on Vercel from git: `index.html`, `for/`, and the functions in `api/`.

## Licence

MIT. The records are public U.S. federal and Minnesota state data.
