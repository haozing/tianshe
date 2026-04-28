# Plugin Helpers Reference

This document is the open-edition reference index for `PluginHelpers`.

Each heading below maps to one public `helpers.*` namespace exposed by
`src/core/js-plugin/helpers.ts`. Cloud-related namespaces are present only as
open compatibility stubs unless explicitly documented otherwise.

## helpers.account

Local account records bound to browser profiles.

## helpers.advanced

Privileged Electron helpers. This namespace is lazily initialized and requires
explicit plugin permissions for real use.

## helpers.button

Dataset button field registration and management helpers.

## helpers.cloud

Open-edition compatibility stub. It reports a logged-out session and rejects
cloud auth setup.

## helpers.customField

Open-edition compatibility stub for cloud custom fields. Cloud-backed custom
field operations are unavailable in this edition.

## helpers.cv

OpenCV-backed image processing helpers.

## helpers.database

Local dataset query, import, export, schema, and record mutation helpers.

## helpers.ffi

Native FFI library loading, callback, and struct helpers.

## helpers.image

Perceptual hash and SSIM image comparison helpers.

## helpers.imageSearch

Local image feature extraction, template indexing, and similarity search.

## helpers.network

HTTP request and webhook helpers for plugins.

## helpers.ocr

OCR recognition, text search, preprocessing, and OCR worker pool helpers.

## helpers.onnx

ONNX model loading, inference, tensor, embedding, and image preprocessing
helpers.

## helpers.openai

OpenAI-compatible chat, streaming, embedding, file, batch, speech, image, and
moderation helpers.

## helpers.plugin

Plugin metadata, manifest, storage path, config, and data table introspection.

## helpers.profile

Browser profile management, fingerprint helpers, runtime descriptors, and
browser lease/launch helpers.

## helpers.raw

Raw Electron/WebContents access surface.

## helpers.savedSite

Saved site CRUD and platform initialization helpers.

## helpers.scheduler

Scheduled task creation, pause/resume, trigger, history, and disposal helpers.

## helpers.storage

Plugin configuration and plugin-scoped persistent data helpers.

## helpers.taskQueue

Plugin task queue creation, active queue listing, cancellation, and cleanup.

## helpers.ui

Renderer-facing UI helpers, including notification toast forwarding and current
dataset context.

## helpers.utils

Common utility helpers such as IDs, sleeps, chunking, validation, cloning, and
date formatting.

## helpers.vectorIndex

Local HNSW vector index creation, mutation, search, persistence, and rebuild
helpers.

## helpers.webhook

Plugin webhook registration, event emission, and cleanup helpers.

## helpers.window

Plugin modal window helpers.
