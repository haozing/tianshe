import { parentPort } from 'worker_threads';
import path from 'path';
import type { Box4, CropResult, FindCropsOptions, Point, RGBAImage, RotatedRect } from './types';
import { AIRPA_RUNTIME_CONFIG } from '../../../constants/runtime-config';

type WorkerRequest =
  | { id: string; op: 'ping' }
  | {
      id: string;
      op: 'findCrops';
      payload: {
        image: {
          width: number;
          height: number;
          data: ArrayBuffer;
          byteOffset?: number;
          byteLength?: number;
        };
        options?: FindCropsOptions;
      };
    };

type WorkerResponse =
  | { id: string; ok: true; result: any; transfer?: ArrayBuffer[] }
  | { id: string; ok: false; error: { message: string; stack?: string } };

function ensureParentPort(): NonNullable<typeof parentPort> {
  if (!parentPort) {
    throw new Error('opencvjs-worker: parentPort is not available');
  }
  return parentPort;
}

function toErr(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) return { message: error.message, stack: error.stack };
  return { message: String(error) };
}

// Lazy-load cv on first use (opencv-js init is expensive).
// @techstark/opencv-js is a thenable module: it needs to be awaited before cv.Mat exists.
type CVHolder = { cv: any };

let cv: any | null = null;
let cvPromise: Promise<CVHolder> | null = null;
const debugEnabled = AIRPA_RUNTIME_CONFIG.cv.workerDebug;
const verboseEnabled = AIRPA_RUNTIME_CONFIG.cv.workerDebugVerbose;

function debugLog(message: string, ...args: unknown[]): void {
  if (!debugEnabled) return;
  if (args.length > 0) {
    console.log('[opencvjs-worker]', message, ...args);
  } else {
    console.log('[opencvjs-worker]', message);
  }
}

function nowMs(): number {
  return Date.now();
}

async function getCV(): Promise<CVHolder> {
  if (cv) return { cv };
  if (cvPromise) return cvPromise;

  const startedAt = nowMs();
  debugLog('loading opencv-js');

  if (debugEnabled) {
    const g = globalThis as any;
    const moduleOverrides = g.Module && typeof g.Module === 'object' ? g.Module : {};
    const prevOnRuntimeInitialized = moduleOverrides.onRuntimeInitialized;
    moduleOverrides.onRuntimeInitialized = () => {
      debugLog('opencv-js runtime initialized');
      if (typeof prevOnRuntimeInitialized === 'function') {
        prevOnRuntimeInitialized();
      }
    };
    moduleOverrides.onAbort = (what: unknown) => {
      debugLog(`opencv-js abort: ${String(what)}`);
    };
    moduleOverrides.printErr = (...args: unknown[]) => {
      debugLog('opencv-js stderr', ...args);
    };
    moduleOverrides.monitorRunDependencies = (left: number) => {
      debugLog(`opencv-js runDependencies=${left}`);
    };
    g.Module = moduleOverrides;
  }

  // When worker entry is unpacked (app.asar.unpacked), module resolution won't
  // naturally walk into app.asar/node_modules. Add it explicitly so requiring
  // dependencies packaged in asar still works.
  try {
    const resourcesPath = (process as any).resourcesPath;
    if (typeof resourcesPath === 'string' && resourcesPath.length > 0) {
      const appAsarNodeModules = path.join(resourcesPath, 'app.asar', 'node_modules');
      const paths = (module as any).paths as string[] | undefined;
      if (Array.isArray(paths) && !paths.includes(appAsarNodeModules)) {
        paths.push(appAsarNodeModules);
      }
    }
  } catch {
    // ignore
  }

  cvPromise = Promise.resolve()
    .then(() => {
      const loaded = require('@techstark/opencv-js');
      const thenable = typeof (loaded as any)?.then === 'function';
      debugLog(`opencv-js module loaded (thenable=${thenable})`);

      if (thenable) {
        if (debugEnabled) {
          (loaded as any).then(() => {
            debugLog('opencv-js then callback fired');
          });
        }
        debugLog('opencv-js waiting for runtime init');
        return new Promise<CVHolder>((resolve) => {
          (loaded as any).then((resolved: any) => resolve({ cv: resolved }));
        });
      }

      return { cv: loaded };
    })
    .then((holder) => {
      cv = holder.cv;
      debugLog(`opencv-js ready in ${nowMs() - startedAt}ms`);
      return holder;
    });

  return cvPromise;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(n, max));
}

function toPoint(p: any): Point {
  return [Number(p[0] ?? p.x ?? 0), Number(p[1] ?? p.y ?? 0)];
}

function orderPointsClockwise(pts: Box4): Box4 {
  const rect: Box4 = [
    [0, 0],
    [0, 0],
    [0, 0],
    [0, 0],
  ];
  const sums = pts.map((pt) => pt[0] + pt[1]);
  rect[0] = pts[sums.indexOf(Math.min(...sums))]!;
  rect[2] = pts[sums.indexOf(Math.max(...sums))]!;
  const remaining = pts.filter((pt) => pt !== rect[0] && pt !== rect[2]) as [Point, Point];
  const diff = [remaining[1][0] - remaining[0][0], remaining[1][1] - remaining[0][1]];
  rect[1] = remaining[diff.indexOf(Math.min(...diff))]!;
  rect[3] = remaining[diff.indexOf(Math.max(...diff))]!;
  return rect;
}

function linalgNorm(p0: Point, p1: Point): number {
  return Math.sqrt((p0[0] - p1[0]) ** 2 + (p0[1] - p1[1]) ** 2);
}

function int(n: number): number {
  return n > 0 ? Math.floor(n) : Math.ceil(n);
}

function boxPointsFromRotatedRect(r: RotatedRect): Box4 {
  const width = r.size.width;
  const height = r.size.height;
  const theta = (r.angle * Math.PI) / 180.0;
  const cosTheta = Math.cos(theta);
  const sinTheta = Math.sin(theta);
  const cx = r.center[0];
  const cy = r.center[1];
  const dx = width * 0.5;
  const dy = height * 0.5;
  const tl: Point = [cx - dx * cosTheta + dy * sinTheta, cy - dx * sinTheta - dy * cosTheta];
  const tr: Point = [cx + dx * cosTheta + dy * sinTheta, cy + dx * sinTheta - dy * cosTheta];
  const br: Point = [cx + dx * cosTheta - dy * sinTheta, cy + dx * sinTheta + dy * cosTheta];
  const bl: Point = [cx - dx * cosTheta - dy * sinTheta, cy - dx * sinTheta + dy * cosTheta];
  return [tl, tr, br, bl];
}

function rotatedRectFromCv(r: any): RotatedRect {
  return {
    center: [Number(r.center?.x ?? 0), Number(r.center?.y ?? 0)],
    size: { width: Number(r.size?.width ?? 0), height: Number(r.size?.height ?? 0) },
    angle: Number(r.angle ?? 0),
  };
}

function cvMatFromRGBAImage(cvRef: any, image: RGBAImage): any {
  // opencv-js expects an object with {width,height,data}. It does not require DOM ImageData in Node.
  return cvRef.matFromImageData({
    width: image.width,
    height: image.height,
    data: new Uint8ClampedArray(image.data),
  });
}

function matToRGBAImage(mat: any): RGBAImage {
  const width = mat.cols;
  const height = mat.rows;
  const data = new Uint8Array(mat.data);
  return { width, height, data };
}

async function findCrops(image: RGBAImage, options?: FindCropsOptions): Promise<CropResult[]> {
  if (debugEnabled) {
    debugLog('findCrops start');
  }
  const cvHolder = await getCV();
  const cvRef = cvHolder.cv;
  if (debugEnabled) {
    debugLog('findCrops cv ready');
  }
  const minSide = typeof options?.minSide === 'number' ? options!.minSide! : 3;
  const maxCrops = typeof options?.maxCrops === 'number' ? options!.maxCrops! : 200;

  const mode = options?.mode ?? 'canny';
  const cannyT1 = clamp(Number(options?.cannyThreshold1 ?? 50), 0, 9999);
  const cannyT2 = clamp(Number(options?.cannyThreshold2 ?? 150), 0, 9999);
  const thresholdValue = clamp(Number(options?.thresholdValue ?? 180), 0, 255);

  const src = cvMatFromRGBAImage(cvRef, image);
  const gray = new cvRef.Mat();
  const bin = new cvRef.Mat();
  const contours = new cvRef.MatVector();
  const hierarchy = new cvRef.Mat();
  const crops: CropResult[] = [];

  try {
    cvRef.cvtColor(src, gray, cvRef.COLOR_RGBA2GRAY, 0);
    if (mode === 'threshold') {
      cvRef.threshold(gray, bin, thresholdValue, 255, cvRef.THRESH_BINARY);
    } else {
      cvRef.Canny(gray, bin, cannyT1, cannyT2);
    }

    cvRef.findContours(bin, contours, hierarchy, cvRef.RETR_LIST, cvRef.CHAIN_APPROX_SIMPLE);

    for (let i = 0; i < contours.size(); i++) {
      if (crops.length >= maxCrops) break;

      const cnt = contours.get(i);
      if (!cnt) continue;
      const rr = cvRef.minAreaRect(cnt);
      const rotatedRect = rotatedRectFromCv(rr);
      const sside = Math.min(rotatedRect.size.width, rotatedRect.size.height);
      if (!Number.isFinite(sside) || sside < minSide) {
        cnt.delete?.();
        continue;
      }

      const rawBox = boxPointsFromRotatedRect(rotatedRect).map((p) => toPoint(p)) as Box4;
      const box = orderPointsClockwise(rawBox).map((p) => [
        clamp(int(p[0]), 0, image.width),
        clamp(int(p[1]), 0, image.height),
      ]) as Box4;

      const rectWidth = int(linalgNorm(box[0], box[1]));
      const rectHeight = int(linalgNorm(box[0], box[3]));
      if (rectWidth <= 3 || rectHeight <= 3) {
        cnt.delete?.();
        continue;
      }

      const dstW = Math.max(1, rectWidth);
      const dstH = Math.max(1, rectHeight);

      const srcTri = cvRef.matFromArray(4, 1, cvRef.CV_32FC2, [
        box[0][0],
        box[0][1],
        box[1][0],
        box[1][1],
        box[2][0],
        box[2][1],
        box[3][0],
        box[3][1],
      ]);
      const dstTri = cvRef.matFromArray(4, 1, cvRef.CV_32FC2, [0, 0, dstW, 0, dstW, dstH, 0, dstH]);

      const M = cvRef.getPerspectiveTransform(srcTri, dstTri);
      const dst = new cvRef.Mat();

      try {
        cvRef.warpPerspective(
          src,
          dst,
          M,
          new cvRef.Size(dstW, dstH),
          cvRef.INTER_CUBIC,
          cvRef.BORDER_REPLICATE
        );
      } finally {
        srcTri.delete();
        dstTri.delete();
        M.delete();
      }

      let out = dst;
      try {
        if (dstH / Math.max(1, dstW) >= 1.5) {
          const dstRot = new cvRef.Mat();
          const dsizeRot = new cvRef.Size(dst.rows, dst.cols);
          const center = new cvRef.Point(dst.cols / 2, dst.cols / 2);
          const rotM = cvRef.getRotationMatrix2D(center, 90, 1);
          try {
            cvRef.warpAffine(
              dst,
              dstRot,
              rotM,
              dsizeRot,
              cvRef.INTER_CUBIC,
              cvRef.BORDER_REPLICATE
            );
            out = dstRot;
          } finally {
            rotM.delete();
            if (out !== dstRot) dstRot.delete();
          }
        }

        // Copy out data; Mat memory lives in wasm heap and will be freed by delete().
        const outImg = matToRGBAImage(out);
        const copied = new Uint8Array(outImg.data);
        crops.push({
          box,
          rotatedRect,
          image: { width: outImg.width, height: outImg.height, data: copied },
        });
      } finally {
        if (out !== dst) out.delete();
        dst.delete();
        cnt.delete?.();
      }
    }
  } finally {
    src.delete();
    gray.delete();
    bin.delete();
    contours.delete();
    hierarchy.delete();
  }

  return crops;
}

const port = ensureParentPort();
port.postMessage({ type: 'ready' });

port.on('message', (msg: WorkerRequest) => {
  const id = msg?.id;
  if (!id) return;

  const respond = (response: WorkerResponse) => {
    if (response.ok && response.transfer?.length) {
      port.postMessage(response, response.transfer);
    } else {
      port.postMessage(response);
    }
  };

  void (async () => {
    const opStartedAt = verboseEnabled ? nowMs() : 0;
    try {
      if (msg.op === 'ping') {
        respond({ id, ok: true, result: { pong: true, pid: process.pid } });
        if (verboseEnabled) {
          debugLog(`op=ping done in ${nowMs() - opStartedAt}ms`);
        }
        return;
      }

      if (msg.op === 'findCrops') {
        const { image, options } = msg.payload || ({} as any);
        const byteOffset = Number(image?.byteOffset ?? 0) || 0;
        const byteLength = Number(image?.byteLength ?? 0) || 0;

        const rgba: RGBAImage = {
          width: Number(image?.width ?? 0),
          height: Number(image?.height ?? 0),
          data: new Uint8Array(
            (image?.data as ArrayBuffer) || new ArrayBuffer(0),
            byteOffset,
            byteLength > 0 ? byteLength : undefined
          ),
        };

        const crops = await findCrops(rgba, options);
        const transfer: ArrayBuffer[] = [];
        for (const c of crops) {
          transfer.push(c.image.data.buffer as ArrayBuffer);
        }

        respond({ id, ok: true, result: crops, transfer });
        if (verboseEnabled) {
          debugLog(`op=findCrops done in ${nowMs() - opStartedAt}ms`);
        }
        return;
      }

      respond({ id, ok: false, error: { message: `Unknown op: ${String((msg as any).op)}` } });
    } catch (error) {
      respond({ id, ok: false, error: toErr(error) });
    }
  })();
});
