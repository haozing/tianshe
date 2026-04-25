import type { ReactNode } from 'react';
import { icons, type LucideIcon } from 'lucide-react';

const ICON_URL_PATTERN = /^(https?:\/\/|data:image\/)/i;
const SIMPLE_ICON_NAME_PATTERN = /^[a-zA-Z0-9\-_ ]+$/;

function capitalize(part: string): string {
  if (!part) return '';
  return part.charAt(0).toUpperCase() + part.slice(1);
}

export function resolveLucideIcon(icon: string): LucideIcon | null {
  const raw = icon.replace(/^lucide:/i, '').trim();
  if (!raw) return null;

  const iconMap = icons as Record<string, LucideIcon | undefined>;

  const directMatch = iconMap[raw];
  if (directMatch) return directMatch;

  const pascalMatch = iconMap[capitalize(raw)];
  if (pascalMatch) return pascalMatch;

  const delimiterMatch = iconMap[
    raw
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map(capitalize)
      .join('')
  ];
  if (delimiterMatch) return delimiterMatch;

  const camelLikeMatch = iconMap[
    raw
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .split('-')
      .filter(Boolean)
      .map(capitalize)
      .join('')
  ];
  if (camelLikeMatch) return camelLikeMatch;

  return null;
}

function isEmojiLike(icon: string): boolean {
  const value = icon.trim();
  if (!value) return false;
  if (/[\p{Extended_Pictographic}\uFE0F]/u.test(value)) return true;
  return value.length <= 4 && !SIMPLE_ICON_NAME_PATTERN.test(value);
}

export interface RenderStringIconOptions {
  size?: number;
  lucideClassName?: string;
  emojiClassName?: string;
  imageClassName?: string;
  alt?: string;
  fallback?: ReactNode;
}

export function renderStringIcon(
  icon: string | null | undefined,
  options: RenderStringIconOptions = {}
): ReactNode {
  const value = icon?.trim();
  if (!value) {
    return options.fallback ?? null;
  }

  if (ICON_URL_PATTERN.test(value)) {
    return <img src={value} alt={options.alt ?? ''} className={options.imageClassName} />;
  }

  const lucideIcon = resolveLucideIcon(value);
  if (lucideIcon) {
    const LucideIcon = lucideIcon;
    return <LucideIcon size={options.size ?? 16} className={options.lucideClassName} />;
  }

  if (isEmojiLike(value)) {
    return <span className={options.emojiClassName}>{value}</span>;
  }

  const text = Array.from(value).slice(0, 2).join('');
  return <span className={options.emojiClassName}>{text}</span>;
}
