import { parentPort } from 'worker_threads';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { dynamicImport } from '../../utils/dynamic-import';
import { resolveAsarExtractBaseDir, resolveUserDataDir } from '../../../constants/runtime-config';

type OcrDetectResult = Array<{
  text: string;
  mean: number;
  box: [[number, number], [number, number], [number, number], [number, number]];
}>;

type OcrInstance = {
  detect(image: string | Buffer): Promise<OcrDetectResult>;
};

type OcrFactory = {
  create(options?: {
    isDebug?: boolean;
    debugOutputDir?: string;
    models?: {
      detectionPath: string;
      recognitionPath: string;
      dictionaryPath: string;
    };
  }): Promise<OcrInstance>;
};

type WorkerRequest =
  | { id: string; op: 'ping' }
  | { id: string; op: 'init' }
  | { id: string; op: 'detect'; payload: { image: string | Buffer } }
  | { id: string; op: 'reset' };

type WorkerResponse =
  | { id: string; ok: true; result: unknown }
  | {
      id: string;
      ok: false;
      error: WorkerErrorPayload;
    };

type WorkerErrorPayload = {
  message: string;
  stack?: string;
  code?: number;
  rawType?: string;
  rawValue?: string;
};

function ensureParentPort(): NonNullable<typeof parentPort> {
  if (!parentPort) {
    throw new Error('ocr-worker: parentPort is not available');
  }
  return parentPort;
}

function extractNumericCode(error: unknown): number | null {
  if (typeof error === 'number' && Number.isFinite(error)) return error;
  if (typeof error === 'string' && /^\d+$/.test(error)) return Number.parseInt(error, 10);

  if (error && typeof error === 'object') {
    const asAny = error as Record<string, unknown>;
    const data = asAny.data;
    if (typeof data === 'number' && Number.isFinite(data)) return data;
    const message = asAny.message;
    if (typeof message === 'string' && /^\d+$/.test(message)) return Number.parseInt(message, 10);
  }

  return null;
}

function safeStringifyUnknown(value: unknown): string {
  try {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      return String(value);
    }
    if (value === null || value === undefined) return String(value);
    if (value instanceof Error) return value.message || String(value);
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toErr(error: unknown): WorkerErrorPayload {
  const code = extractNumericCode(error);
  if (error instanceof Error) {
    return {
      message: error.message || 'OCR worker error',
      stack: error.stack,
      code: code ?? undefined,
    };
  }
  return {
    message: safeStringifyUnknown(error) || 'OCR worker error',
    code: code ?? undefined,
    rawType: typeof error,
    rawValue: safeStringifyUnknown(error),
  };
}

function patchModuleResolutionForAsar(): void {
  try {
    const resourcesPath = (process as any).resourcesPath;
    if (typeof resourcesPath !== 'string' || resourcesPath.length === 0) return;
    const appAsarNodeModules = path.join(resourcesPath, 'app.asar', 'node_modules');
    const paths = (module as any).paths as string[] | undefined;
    if (Array.isArray(paths) && !paths.includes(appAsarNodeModules)) {
      paths.push(appAsarNodeModules);
    }
  } catch {
    // ignore
  }
}

function preferUnpackedPath(candidatePath: string): string {
  const raw = String(candidatePath || '').trim();
  if (!raw) return '';

  const unpackedPath = raw.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
  if (unpackedPath !== raw && fs.existsSync(unpackedPath)) {
    return unpackedPath;
  }

  if (raw !== unpackedPath && /([\\/])app\.asar([\\/])/i.test(raw)) {
    const extracted = extractAsarFileToDisk(raw);
    if (extracted) return extracted;
  }

  return raw;
}

function extractAsarFileToDisk(asarVirtualPath: string): string | null {
  const raw = String(asarVirtualPath || '').trim();
  if (!raw) return null;
  const m = raw.match(/([\\/])app\.asar([\\/])(.*)$/i);
  if (!m) return null;

  try {
    if (!fs.existsSync(raw)) return null;
  } catch {
    return null;
  }

  const rel = String(m[3] || '').replace(/^[\\/]+/, '');
  if (!rel) return null;

  const configuredBase = resolveAsarExtractBaseDir() ?? resolveUserDataDir('');
  const base = configuredBase.trim() || os.tmpdir();
  const outPath = path.join(base, 'tiansheai-asar-extract', rel);

  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });

    const srcStat = fs.statSync(raw);
    if (fs.existsSync(outPath)) {
      try {
        const dstStat = fs.statSync(outPath);
        if (dstStat.size === srcStat.size && dstStat.size > 0) {
          return outPath;
        }
      } catch {
        // ignore, rewrite below
      }
    }

    const buf = fs.readFileSync(raw);
    if (!buf || buf.length === 0) return null;
    fs.writeFileSync(outPath, buf);
    return outPath;
  } catch {
    return null;
  }
}

function isAsarVirtualPath(candidatePath: string): boolean {
  const raw = String(candidatePath || '').trim();
  if (!raw) return false;
  if (/([\\/])app\.asar\.unpacked([\\/])/i.test(raw)) return false;
  return /([\\/])app\.asar([\\/])/i.test(raw);
}

function resolveModelsFromResourcesPath(resourcesPath: unknown): {
  detectionPath: string;
  recognitionPath: string;
  dictionaryPath: string;
} | null {
  if (typeof resourcesPath !== 'string' || resourcesPath.length === 0) return null;

  const base = path.join(
    resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    '@gutenye',
    'ocr-models',
    'assets'
  );
  const detectionPath = path.join(base, 'ch_PP-OCRv4_det_infer.onnx');
  const recognitionPath = path.join(base, 'ch_PP-OCRv4_rec_infer.onnx');
  const dictionaryPath = path.join(base, 'ppocr_keys_v1.txt');
  const ok =
    fs.existsSync(detectionPath) && fs.existsSync(recognitionPath) && fs.existsSync(dictionaryPath);
  if (!ok) return null;
  return { detectionPath, recognitionPath, dictionaryPath };
}

async function resolveBundledModelPaths(): Promise<{
  detectionPath: string;
  recognitionPath: string;
  dictionaryPath: string;
} | null> {
  const resourcesPath = (process as any).resourcesPath;
  const byResources = resolveModelsFromResourcesPath(resourcesPath);
  if (byResources) return byResources;

  try {
    const modelsModule = await importByRequireResolve('@gutenye/ocr-models/node');
    const exported = (modelsModule as any)?.default || modelsModule;
    const asAny = exported as Record<string, unknown>;

    const detRaw = String(asAny.detectionPath || '');
    const recRaw = String(asAny.recognitionPath || '');
    const dicRaw = String(asAny.dictionaryPath || '');

    const detectionPath = preferUnpackedPath(detRaw) || detRaw;
    const recognitionPath = preferUnpackedPath(recRaw) || recRaw;
    const dictionaryPath = preferUnpackedPath(dicRaw) || dicRaw;

    // Do not pass app.asar virtual paths to native onnxruntime; they are not real files for OS-level I/O.
    if (
      isAsarVirtualPath(detectionPath) ||
      isAsarVirtualPath(recognitionPath) ||
      isAsarVirtualPath(dictionaryPath)
    ) {
      return null;
    }

    if (
      !fs.existsSync(detectionPath) ||
      !fs.existsSync(recognitionPath) ||
      !fs.existsSync(dictionaryPath)
    ) {
      return null;
    }

    return { detectionPath, recognitionPath, dictionaryPath };
  } catch {
    return null;
  }
}

let ocr: OcrInstance | null = null;
let initPromise: Promise<void> | null = null;

async function ensureInitialized(): Promise<void> {
  if (ocr) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const OcrModule = await importByRequireResolve<{ default?: OcrFactory } | OcrFactory>(
      '@gutenye/ocr-node'
    );
    const Ocr = (OcrModule as any)?.default || OcrModule;

    const models = await resolveBundledModelPaths();
    ocr = await (Ocr as OcrFactory).create({
      isDebug: false,
      ...(models ? { models } : {}),
    });
  })().finally(() => {
    initPromise = null;
  });

  return initPromise;
}

async function importByRequireResolve<T = unknown>(specifier: string): Promise<T> {
  patchModuleResolutionForAsar();
  try {
    const resolved = require.resolve(specifier);
    return await dynamicImport<T>(pathToFileURL(resolved).href);
  } catch {
    return await dynamicImport<T>(specifier);
  }
}

async function resetEngine(): Promise<void> {
  ocr = null;
  initPromise = null;
  try {
    (globalThis as any).gc?.();
  } catch {
    // ignore
  }
}

const port = ensureParentPort();
port.postMessage({ type: 'ready' });

port.on('message', (msg: WorkerRequest) => {
  const id = msg?.id;
  if (!id) return;

  const respond = (response: WorkerResponse) => {
    port.postMessage(response);
  };

  void (async () => {
    try {
      if (msg.op === 'ping') {
        respond({ id, ok: true, result: { pong: true, pid: process.pid } });
        return;
      }

      if (msg.op === 'init') {
        await ensureInitialized();
        respond({ id, ok: true, result: { initialized: true } });
        return;
      }

      if (msg.op === 'reset') {
        await resetEngine();
        respond({ id, ok: true, result: { reset: true } });
        return;
      }

      if (msg.op === 'detect') {
        await ensureInitialized();
        if (!ocr) throw new Error('OCR not initialized');
        const rawImage = (msg as any)?.payload?.image as unknown;
        const image = normalizeImageInput(rawImage);
        const results = await ocr.detect(image);
        respond({ id, ok: true, result: results });
        return;
      }

      respond({ id, ok: false, error: { message: `Unknown op: ${String((msg as any).op)}` } });
    } catch (error) {
      respond({ id, ok: false, error: toErr(error) });
    }
  })();
});

function normalizeImageInput(value: unknown): string | Buffer {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value;

  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }

  if (ArrayBuffer.isView(value)) {
    // Covers Uint8Array/Buffer-like structures produced by structuredClone.
    const u8 = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return Buffer.from(u8);
  }

  throw new Error(`Invalid OCR image input: ${typeof value}`);
}
