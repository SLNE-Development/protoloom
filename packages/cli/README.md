# weaver

Command-line client for [Weaver](https://github.com/SLNE-Development/weaver), a self-hosted registry
for `.proto` files. `weaver fetch` downloads the proto bundles your project depends on, with their
transitive dependencies, into a local directory.

Requires Node.js 22.3 or newer.

## Install

```sh
npm i -D @slne/weaver-cli
# or
pnpm add -D @slne/weaver-cli
```

Or run it without installing: `npx @slne/weaver-cli fetch`.

## Configure

Create `weaver.json` next to your `package.json`:

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
| `url` | Registry base URL. Optional; `WEAVER_URL` takes precedence. |

## Run

```sh
export WEAVER_URL=https://protos.example.com
export WEAVER_TOKEN=pl_...     # API key; only needed for private repositories
npx @slne/weaver-cli fetch [--config weaver.json] [--out ./protos]
```

A typical `package.json` script:

```json
{ "scripts": { "protos": "weaver fetch" } }
```

Downloads are verified against their SHA-256 and cached in `node_modules/.cache/weaver`
(or `~/.cache/weaver` outside a Node project).

## License

MIT
