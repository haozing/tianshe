export type RGBAImage = {
  width: number;
  height: number;
  data: Uint8Array;
};

export type Point = [number, number];
export type Box4 = [Point, Point, Point, Point];

export type RotatedRect = {
  center: Point;
  size: { width: number; height: number };
  angle: number;
};

export type CropResult = {
  box: Box4;
  rotatedRect: RotatedRect;
  image: RGBAImage;
};

export type FindCropsOptions = {
  mode?: 'canny' | 'threshold';
  cannyThreshold1?: number;
  cannyThreshold2?: number;
  thresholdValue?: number;
  minSide?: number;
  maxCrops?: number;
};
