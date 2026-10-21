# protoloom

Command-line client for [Protoloom](https://github.com/slne-development/protoloom), a self-hosted registry
for `.proto` files. `protoloom fetch` downloads the proto bundles your project depends on, with their
transitive dependencies, into a local directory.

Requires Node.js 22.3 or newer.

## Install

```sh
npm i -D protoloom
# or
pnpm add -D protoloom
```

Or run it without installing: `npx protoloom fetch`.

## Configure

Create `protoloom.json` next to your `package.json`:

```json
{
  "repositories": ["releases"],
  "dependencies": ["com.example:common-types:2.0.0"],
  "outDir": "./protos"
}
```

| Field | Description |
| --- | --- |
| `repositories` | Repositories searched for each dependency, in order. |
| `dependencies` | Coordinates `group:name:version`. |
| `outDir` | Output directory, default `./protos`. |
| `url` | Registry base URL. Optional; `PROTOLOOM_URL` takes precedence. |

## Run

```sh
export PROTOLOOM_URL=https://protos.example.com
export PROTOLOOM_TOKEN=pl_...     # API key; only needed for private repositories
npx protoloom fetch [--config protoloom.json] [--out ./protos]
```

A typical `package.json` script:

```json
{ "scripts": { "protos": "protoloom fetch" } }
```

Downloads are verified against their SHA-256 and cached in `node_modules/.cache/protoloom`
(or `~/.cache/protoloom` outside a Node project).

## License

MIT
