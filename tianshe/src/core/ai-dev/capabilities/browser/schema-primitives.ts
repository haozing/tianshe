import { z } from 'zod';

export const optionalBoolean = z.boolean().optional();

export const optionalNumber = z.number().optional();

export const optionalString = z.string().optional();

export const positiveInt = z.number().int().positive();

export const nonNegativeInt = z.number().int().nonnegative();

export const selectorSchema = z
  .string()
  .min(1)
  .describe('Airpa selector syntax，支持 CSS，以及 :has-text("...")、:visible');

export const urlSchema = z
  .string()
  .url()
  .or(z.string().startsWith('/'))
  .describe('Target URL');
