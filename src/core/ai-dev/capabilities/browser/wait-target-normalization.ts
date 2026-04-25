import type { TextRegionV3 } from './tool-v3-shapes';

type WaitConditionState = 'attached' | 'visible';
type WaitConditionTextOptions = {
  strategy?: 'auto' | 'dom' | 'ocr';
  exactMatch?: boolean;
  region?: TextRegionV3;
};

export type ElementActionWaitTargetInput = {
  kind: 'element';
  selector?: string;
  ref?: string;
  state?: WaitConditionState;
};

export type TextActionWaitTargetInput = {
  kind: 'text';
  text: string;
} & WaitConditionTextOptions;

export type TextAbsentActionWaitTargetInput = {
  kind: 'text_absent';
  text: string;
} & WaitConditionTextOptions;

export type UrlActionWaitTargetInput = {
  kind: 'url';
  urlIncludes: string;
};

export type ActionWaitTargetGroupInput =
  | { kind: 'all'; conditions: ActionWaitTargetInput[] }
  | { kind: 'any'; conditions: ActionWaitTargetInput[] };

export type ActionWaitTargetInput =
  | ElementActionWaitTargetInput
  | TextActionWaitTargetInput
  | TextAbsentActionWaitTargetInput
  | UrlActionWaitTargetInput
  | ActionWaitTargetGroupInput;
