function actionList(adapter, planKey, fallbackActions = []) {
  const actions = adapter?.operationPlans?.[planKey]?.actions;
  return Array.isArray(actions) && actions.length ? actions : fallbackActions;
}

function hasAction(adapter, planKey, actionName, fallbackActions = []) {
  return actionList(adapter, planKey, fallbackActions).some((action) => action?.action === actionName);
}

async function runActionList(adapter, planKey, context, handlers, fallbackActions = []) {
  const actions = actionList(adapter, planKey, fallbackActions);
  const results = [];
  for (const action of actions) {
    const name = action?.action;
    const handler = handlers[name];
    if (!handler) {
      if (action?.optional || adapter?.capabilities?.unknownActionPolicy === "skip") {
        results.push({ action: name || "", skipped: true, reason: "unknown-action" });
        continue;
      }
      throw new Error(`unsupported doudian operation action: ${name || ""}`);
    }
    try {
      const result = await handler(action, context);
      results.push({ action: name, ok: true, result });
      context.lastResult = result;
      if (result?.stop === true || context.stop === true) break;
    } catch (error) {
      results.push({ action: name, ok: false, error: error?.message || String(error) });
      if (action?.optional || action?.onError === "continue" || action?.onError === "fallback") continue;
      throw error;
    }
  }
  return results;
}

module.exports = { actionList, hasAction, runActionList };
