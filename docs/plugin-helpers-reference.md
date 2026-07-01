# Plugin Helpers Reference

Each heading below maps to one public `helpers.*` namespace exposed by
`src/core/js-plugin/helpers.ts`.

## helpers.account

Account CRUD and profile/platform account helpers.

## helpers.advanced

Privileged Electron helpers that are initialized lazily.

## helpers.button

Dataset button field registration and management helpers.

## helpers.cloud

Open-edition compatibility namespace for cloud helper APIs.

## helpers.customField

Open-edition compatibility namespace for custom field APIs.

## helpers.cv

OpenCV-backed image processing helpers.

## helpers.database

Local dataset query, import, export, schema, and record mutation helpers.

## helpers.ffi

Native FFI library loading, callback, and struct helpers.

## helpers.image

Perceptual hash and SSIM image comparison helpers.

## helpers.imageSearch

Template matching and image similarity search helpers.

## helpers.network

HTTP request and webhook helpers.

## helpers.ocr

OCR recognition, text search, preprocessing, and OCR worker pool helpers.

## helpers.onnx

ONNX model loading, inference, tensor, and image preprocessing helpers.

## helpers.openai

OpenAI chat, embedding, image, speech, transcription, batch, and moderation helpers.

## helpers.plugin

Plugin metadata, data table, and runtime introspection helpers.

## helpers.profile

Profile CRUD, fingerprint, grouping, browser lease, and launch helpers.

## helpers.raw

Low-level Electron WebContents helpers.

## helpers.savedSite

Saved site CRUD and platform initialization helpers.

## helpers.scheduler

Scheduled task creation, pause/resume, trigger, history, and disposal helpers.

## helpers.storage

Plugin configuration and plugin-scoped persistent data helpers.

## helpers.state

Plugin-scoped state has two explicit surfaces:

- `helpers.state.kv` (also available as the legacy top-level `get/set/delete/list/clear`) stores simple key/value data in the plugin lifecycle namespace.
- `helpers.state.rows` is transactional namespaced row state backed by the controlled logical table `state(key, value, updated_at)`. It is intentionally a row store, not a general-purpose relational database.

`helpers.state.clear()` keeps its legacy behavior and clears KV only. Use
`helpers.state.clear({ scope: 'relational', namespace })` for row state, or
`helpers.state.clear({ scope: 'all', namespace })` for both KV and row state.

Row helpers require `manifest.state.rows: true` (`manifest.state.relational: true` is kept as a compatibility alias):

```ts
await helpers.state.rows.upsert('run:cursor', { page: 2 }, { namespace: 'runs' });
const cursor = await helpers.state.rows.get('run:cursor', null, { namespace: 'runs' });
const rows = await helpers.state.rows.list({ prefix: 'run:', namespace: 'runs', limit: 50 });
await helpers.state.rows.delete('run:*', { namespace: 'runs' });
```

Advanced plugins may still use `migrate/query/execute/transaction` against this
controlled row store. SQL is limited to parameterized
`SELECT/INSERT/UPDATE/DELETE` on logical table `state`; DDL, joins,
attach/load/pragma, multiple statements, and arbitrary schemas are not
available. Migration checksums are recorded per plugin id and namespace. All
state is cleared during plugin uninstall cleanup.

## helpers.taskQueue

Task queue creation, concurrency, progress, and batch execution helpers.

## helpers.ui

Notification, dataset context, and UI feedback helpers.

## helpers.utils

Validation, formatting, batching, IDs, and small utility helpers.

## helpers.vectorIndex

Vector index creation, persistence, and nearest-neighbor search helpers.

## helpers.webhook

Plugin webhook registration, event emission, and cleanup helpers.

## helpers.window

Plugin modal window and browser popup helpers.
