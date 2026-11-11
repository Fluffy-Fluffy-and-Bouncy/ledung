# Check-in endpoint

The endpoint of Ledung's anonymous daily check-in (issue #220): a Cloudflare Worker with a D1 database. Ledung sends
`{id, version, channel, os}` once a day to `https://checkin.projectledung.com/v1/checkin`; what Ledung sends and how
to turn it off is in the main README, under "Anonymous usage count".

## What it keeps

One row per install ID: the day it was first seen, the day it was last seen, and the version, channel and operating
system it last sent. Days, not times. No IP address: the Worker never reads it, and Workers observability is off in
`wrangler.toml`. Any other field in a request is dropped before anything is stored.

That covers this Worker only. Cloudflare, as host, still handles each request under its own privacy policy: before
deploying, and after any change to the zone, make sure no Logpush job or other request logging is on for
`checkin.projectledung.com` in the `projectledung.com` zone, so the README's promise holds.

## What it answers

- `POST /v1/checkin` with the four fields: `204`. A malformed body: `400`.
- `GET /v1/counts` with `Authorization: Bearer <COUNTS_TOKEN>`: the unique installs ever seen, the installs active in
  the last 1, 7 and 30 days (today included), and the version, channel and OS split of the 30-day active ones. Without
  the token, or when no token is set: `404`.

```sh
curl -s -H "Authorization: Bearer $COUNTS_TOKEN" https://checkin.projectledung.com/v1/counts
```

## Deploying (not done yet; Martin's step)

From this folder, with Wrangler signed in to the Cloudflare account that holds `projectledung.com`:

```sh
npx wrangler d1 create ledung-checkin          # put the database_id it prints into wrangler.toml
npx wrangler d1 execute ledung-checkin --remote --file schema.sql
npx wrangler secret put COUNTS_TOKEN           # a long random string; keep it to read the counts
npx wrangler deploy
```

Until it is deployed, Ledung's daily check-in fails quietly and tries again a day later.

## Tests

`test/checkin-worker.test.ts` in the repository runs `worker.ts` under Node against `node:sqlite` with `schema.sql`;
`npm run check` type checks and runs it with the rest.
