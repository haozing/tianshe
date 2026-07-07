import {
  BarChart3,
  Bell,
  Gift,
  Headphones,
  LayoutDashboard,
  Maximize2,
  Megaphone,
  Minus,
  Plane,
  RefreshCw,
  Settings,
  ShoppingCart,
  Store,
  User,
  Wallet,
  X,
  Zap
} from "lucide-react";
import type { BusinessModule } from "../types";

const moduleIcons = {
  user: User,
  megaphone: Megaphone,
  monitor: LayoutDashboard,
  chart: BarChart3,
  store: Store,
  gift: Gift,
  cart: ShoppingCart,
  paperPlane: Plane,
  speed: Zap,
  headset: Headphones
};

export function ModuleIcon({ name, className }: { name: BusinessModule["icon"]; className?: string }) {
  const Icon = moduleIcons[name];
  return <Icon className={className || "size-[17px]"} strokeWidth={2} />;
}

export const ShellIcons = {
  Bell,
  Maximize2,
  Minus,
  RefreshCw,
  Settings,
  Store,
  User,
  Wallet,
  X
};
