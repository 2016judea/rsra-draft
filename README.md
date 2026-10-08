# rsra-draft

**Live:** https://rsra-draft.vercel.app

Type a Minnesota property address, get a **draft Records Search with Risk Assessment (RSRA)**: the desk-only environmental report SBA requires on 7(a) and 504 loans over $250,000 (SOP 50 10 8, Procedural Notice 5000-866054).

The draft is built for an Environmental Professional (40 CFR 312.10(b)) to review, make the low/high-risk call and sign. It does the records half of the job:

- **Subject property** from the county parcel record (Metropolitan Council regional parcels, seven-county metro): situs address, PIN, owner, use, year built, boundary.
- **Government records**, every list 40 CFR 312.26 names, each searched to the larger of its CFR and ASTM E1527-21 Table 1 distance, measured from the parcel boundary. The lists, distances and citations are data in [`data/lists.json`](data/lists.json).
- **Historical use** back past 1940: USGS historical topographic maps covering the point, Library of Congress Sanborn editions for the city, the county's year built, and links for aerials and city directories with blank fields for the reviewer's findings.
- **A suggested risk call** from three stated rules ([`RULES`](api/_lib/rsra.js)), with the records each rule fired on. The conclusion box is left for the EP.
- Prints clean to PDF; every page carries "DRAFT FOR ENVIRONMENTAL PROFESSIONAL REVIEW".

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

    node --test test/*.test.js      # unit tests
    python3 scripts/build_sems.py   # refresh the SEMS cache

Deployed on Vercel: `index.html` plus one function, `api/rsra.js`.

## Licence

MIT. The records are public U.S. federal and Minnesota state data.
