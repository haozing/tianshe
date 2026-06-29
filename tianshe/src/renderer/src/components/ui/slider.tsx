/**
 * Slider 组件
 * 基于原生 HTML input[type="range"] 的滑块组件
 */

import * as React from 'react';
import { cn } from '../../lib/utils';

interface SliderProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'onChange' | 'value'
> {
  value?: number[];
  onValueChange?: (value: number[]) => void;
  min?: number;
  max?: number;
  step?: number;
}

const Slider = React.forwardRef<HTMLInputElement, SliderProps>(
  ({ className, value = [0], onValueChange, min = 0, max = 100, step = 1, ...props }, ref) => {
    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = parseFloat(e.target.value);
      onValueChange?.([newValue]);
    };

    // 计算填充百分比
    const percentage = ((value[0] - min) / (max - min)) * 100;

    return (
      <div className={cn('relative flex w-full items-center', className)}>
        <input
          ref={ref}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value[0]}
          onChange={handleChange}
          className="w-full h-1.5 bg-primary/20 rounded-full appearance-none cursor-pointer
            [&::-webkit-slider-thumb]:appearance-none
            [&::-webkit-slider-thumb]:w-4
            [&::-webkit-slider-thumb]:h-4
            [&::-webkit-slider-thumb]:rounded-full
            [&::-webkit-slider-thumb]:bg-background
            [&::-webkit-slider-thumb]:border
            [&::-webkit-slider-thumb]:border-primary/50
            [&::-webkit-slider-thumb]:shadow
            [&::-webkit-slider-thumb]:cursor-pointer
            [&::-webkit-slider-thumb]:transition-colors
            [&::-webkit-slider-thumb]:hover:border-primary
            [&::-moz-range-thumb]:w-4
            [&::-moz-range-thumb]:h-4
            [&::-moz-range-thumb]:rounded-full
            [&::-moz-range-thumb]:bg-background
            [&::-moz-range-thumb]:border
            [&::-moz-range-thumb]:border-primary/50
            [&::-moz-range-thumb]:shadow
            [&::-moz-range-thumb]:cursor-pointer
            focus-visible:outline-none
            focus-visible:ring-1
            focus-visible:ring-ring
            disabled:pointer-events-none
            disabled:opacity-50"
          style={{
            background: `linear-gradient(to right, hsl(var(--primary)) ${percentage}%, hsl(var(--primary) / 0.2) ${percentage}%)`,
          }}
          {...props}
        />
      </div>
    );
  }
);

Slider.displayName = 'Slider';

export { Slider };
