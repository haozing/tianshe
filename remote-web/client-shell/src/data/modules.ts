import { featureRoutes } from "../featureRoutes";
import type { BusinessModule, QuickTask } from "../types";

const iconByParent: Record<string, BusinessModule["icon"]> = {
  "/stores": "store",
  "/warnings": "monitor",
  "/opportunities": "paperPlane",
  "/products": "cart",
  "/marketing": "megaphone"
};

const routeModules: BusinessModule[] = featureRoutes.map((route) => ({
  id: route.route.slice(1).replaceAll("/", "-"),
  label: route.navigation.label,
  icon: iconByParent[route.parentRoute] || "monitor",
  route: route.route,
  summary: route.homeEntry?.description || `${route.navigation.topLabel}入口。`,
  status: route.adapterFeature ? "待接入" : "壳已就绪",
  metrics: [["入口状态", route.adapterFeature ? "受开关控制" : "已接入"], ["所属模块", route.navigation.topLabel]],
  actions: [route.navigation.label]
}));

const primaryByParent = new Map<string, BusinessModule>();
for (const route of featureRoutes) {
  if (!primaryByParent.has(route.parentRoute)) {
    primaryByParent.set(route.parentRoute, routeModules.find((module) => module.route === route.route) as BusinessModule);
  }
}

export const primaryModules = Array.from(primaryByParent.values());
export const secondaryModules = routeModules;
export const allModules = [...primaryModules, ...secondaryModules];
export const quickTasks: QuickTask[] = primaryModules.map((module) => ({
  title: module.label,
  description: module.summary,
  tag: featureRoutes.find((route) => route.route === module.route)?.navigation.topLabel || "工作台"
}));
