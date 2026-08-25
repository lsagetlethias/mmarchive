## What

<!-- What this change does, in one or two sentences. -->

## Why

<!-- The problem it solves. Link an issue if there is one. -->

## Side effects on the Mattermost instance

<!--
Mandatory when touching the extractor. Joining a channel posts a system message
visible to every member: state here whether this change can cause any write, and
which endpoints it calls.
-->

- [ ] This change emits no write request to the instance
- [ ] Or: writes are listed above and go through `MutationGate`

## Checks

- [ ] `pnpm verify` passes
- [ ] Archive format changes are reflected in both `docs/ARCHIVE_FORMAT.md` and the zod schemas
- [ ] `mmarchive-extract verify` passes on a real archive, when relevant
