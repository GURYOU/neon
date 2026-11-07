# Neon (GURYOU fork)

A TypeScript monorepo providing database clients, GraphQL utilities, and validation decorators for Node.js services.

This is the GURYOU fork of [the-neon/neon](https://github.com/the-neon/neon). It publishes four packages to public npm under the `@guryou` scope. Source imports keep the upstream name `@the-neon/core`; consumers alias it (see below).

## Packages

| Package                           | npm name                  | Description                                |
| --------------------------------- | ------------------------- | ------------------------------------------ |
| [core](packages/core)             | `@guryou/neon-core`       | Core decorators, errors, and interfaces    |
| [gql](packages/gql)               | `@guryou/neon-gql`        | GraphQL generator CLI and server utilities |
| [pg](packages/pg)                 | `@guryou/neon-pg`         | PostgreSQL client with transaction support |
| [validation](packages/validation) | `@guryou/neon-validation` | Method argument validation with decorators |
| [mysql](packages/mysql)           | not published             | MySQL client using Sequelize               |
| [dynamodb](packages/dynamodb)     | not published             | DynamoDB client using AWS SDK v3           |

## Consuming the packages

`@guryou/neon-gql` and `@guryou/neon-validation` declare `@the-neon/core` as a peer dependency and import it by that name. The generated GraphQL client also imports `@the-neon/core`. Alias the name to the fork in the consumer's `package.json` so exactly one copy of core is installed (errors are checked with `instanceof`):

```json
{
  "dependencies": {
    "@the-neon/core": "npm:@guryou/neon-core@0.2.7",
    "@the-neon/gql": "npm:@guryou/neon-gql@0.5.5",
    "@the-neon/pg": "npm:@guryou/neon-pg@0.2.5",
    "@the-neon/validation": "npm:@guryou/neon-validation@0.0.15"
  }
}
```

No registry configuration is needed; the packages are public on npmjs.org.

## Releasing

Publishing runs in GitHub Actions ([publish.yml](.github/workflows/publish.yml)) on every `v*` tag, or by hand via workflow_dispatch. It needs the repository secret `NPM_TOKEN` (an npmjs automation token with publish rights on the `@guryou` scope).

1. Bump the versions in `packages/{core,gql,pg,validation}/package.json` (or `pnpm run version:patch` to bump every workspace), update the alias versions in this README, commit and merge into `main`.
2. Tag and push the tag:

```bash
git tag v0.5.5        # any v* name; use the gql version or a date
git push origin v0.5.5
```

3. The workflow installs, builds, tests and runs `pnpm publish -r --no-git-checks` for the four packages. Only `lib/` (and `bin/` for gql) ships, per each package's `files` field. A version that already exists on npm fails the publish step; bump and re-tag.

## Requirements

- Node.js 24+
- pnpm

## Install

```bash
pnpm install
```

## Build

```bash
pnpm run build
```

## Test

```bash
pnpm test
```

## License

MIT
