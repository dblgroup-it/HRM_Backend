# Planned migrations — NOT applied

Files here are deliberately **outside** `prisma/migrations/`, so
`prisma migrate deploy` cannot pick them up. Each one is prepared, reviewed and
waiting for its own scheduled change window.

To apply one, move its directory into `prisma/migrations/`, make the matching
code changes, run the full `release-check.sh`, and deploy it on its own.
