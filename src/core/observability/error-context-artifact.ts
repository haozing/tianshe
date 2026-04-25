import { observationService, type ObservationSpanHandle } from './observation-service';
import type { RuntimeArtifact, TraceContext } from './types';

interface AttachErrorContextArtifactOptions {
  span?: ObservationSpanHandle;
  context?: TraceContext;
  component: string;
  label: string;
  data: unknown;
  attrs?: Record<string, unknown>;
}

export async function attachErrorContextArtifact(
  options: AttachErrorContextArtifactOptions
): Promise<RuntimeArtifact> {
  if (options.span) {
    return await options.span.attachArtifact({
      type: 'error_context',
      component: options.component,
      label: options.label,
      ...(options.attrs ? { attrs: options.attrs } : {}),
      data: options.data,
    });
  }

  return await observationService.attachArtifact({
    context: options.context,
    type: 'error_context',
    component: options.component,
    label: options.label,
    ...(options.attrs ? { attrs: options.attrs } : {}),
    data: options.data,
  });
}
