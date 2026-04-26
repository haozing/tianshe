import type { ReactNode } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Bug,
  Calendar,
  Check,
  CheckCircle,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Circle,
  Code2,
  Cpu,
  Database,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  Film,
  Globe,
  Hash,
  HelpCircle,
  Info,
  Key,
  Layers,
  LayoutDashboard,
  LayoutGrid,
  Link,
  Link2,
  List,
  ListFilter,
  Loader,
  Loader2,
  Monitor,
  MonitorPlay,
  MoreHorizontal,
  Package,
  Paperclip,
  Pencil,
  Percent,
  Play,
  PlayCircle,
  Plug,
  Plus,
  Puzzle,
  RefreshCw,
  RotateCcw,
  Save,
  ScanText,
  Settings,
  Sparkles,
  Store,
  Table,
  Tag,
  Trash2,
  TrendingUp,
  Upload,
  UserRound,
  UserRoundCog,
  Users,
  Webhook,
  X,
  XCircle,
  Zap,
  type LucideIcon,
} from 'lucide-react';

const ICON_URL_PATTERN = /^(https?:\/\/|data:image\/)/i;
const SIMPLE_ICON_NAME_PATTERN = /^[a-zA-Z0-9\-_ ]+$/;
const LUCIDE_ICON_REGISTRY: Record<string, LucideIcon> = {
  AlertCircle,
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Bug,
  Calendar,
  Check,
  CheckCircle,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Circle,
  Code2,
  Cpu,
  Database,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  Film,
  Globe,
  Hash,
  HelpCircle,
  Info,
  Key,
  Layers,
  LayoutDashboard,
  LayoutGrid,
  Link,
  Link2,
  List,
  ListFilter,
  Loader,
  Loader2,
  Monitor,
  MonitorPlay,
  MoreHorizontal,
  Package,
  Paperclip,
  Pencil,
  Percent,
  Play,
  PlayCircle,
  Plug,
  Plus,
  Puzzle,
  RefreshCw,
  RotateCcw,
  Save,
  ScanText,
  Settings,
  Sparkles,
  Store,
  Table,
  Tag,
  Trash2,
  TrendingUp,
  Upload,
  UserRound,
  UserRoundCog,
  Users,
  Webhook,
  X,
  XCircle,
  Zap,
};

function capitalize(part: string): string {
  if (!part) return '';
  return part.charAt(0).toUpperCase() + part.slice(1);
}

export function resolveLucideIcon(icon: string): LucideIcon | null {
  const raw = icon.replace(/^lucide:/i, '').trim();
  if (!raw) return null;

  const directMatch = LUCIDE_ICON_REGISTRY[raw];
  if (directMatch) return directMatch;

  const pascalMatch = LUCIDE_ICON_REGISTRY[capitalize(raw)];
  if (pascalMatch) return pascalMatch;

  const delimiterMatch = LUCIDE_ICON_REGISTRY[
    raw
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map(capitalize)
      .join('')
  ];
  if (delimiterMatch) return delimiterMatch;

  const camelLikeMatch = LUCIDE_ICON_REGISTRY[
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
