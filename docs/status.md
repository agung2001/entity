[← README](../README.md)

# Status

Entity is **growing**. This documentation describes what exists today, not what is
planned.

- The code is the reference.
- The interface rules live in [`DESIGN.md`](../DESIGN.md) — every UI change is held
  to that contract, and `npm test` enforces the two loudest rules statically.
- The test suite is the closest thing to a specification:
  `npm test` (unit + UI contract), `npm run test:smoke`, `npm run test:regression`.
- Interfaces may move while the shape settles.

## Not included on purpose

| Not used | Why |
| --- | --- |
| `pinia` (state management) | one reactive store per domain is enough; fewer layers to debug |
| TypeScript | the call table is the contract, and it is validated at the boundary |
| Auto-update | an app that owns your files should not replace itself silently |

## Related

- [Quickstart](quickstart.md)
- [Limits](limits.md)
- [Architecture](architecture.md)
