import type {
  FailureBundle,
  RecentFailureSummary,
  RuntimeArtifact,
  RuntimeArtifactRef,
  RuntimeEvent,
  TraceTimeline,
  TraceSummary,
} from '../core/observability/types';
import { RuntimeObservationService } from './duckdb/runtime-observation-service';

function isFailureEvent(event: RuntimeEvent): boolean {
  return (
    event.outcome === 'failed' ||
    event.outcome === 'blocked' ||
    event.outcome === 'timeout' ||
    event.level === 'error'
  );
}

function toArtifactRef(artifact: RuntimeArtifact): RuntimeArtifactRef {
  return {
    artifactId: artifact.artifactId,
    type: artifact.type,
    ...(artifact.label ? { label: artifact.label } : {}),
    timestamp: artifact.timestamp,
  };
}

function resolveFinalStatus(events: RuntimeEvent[]): TraceSummary['finalStatus'] {
  if (events.length === 0) {
    return 'unknown';
  }
  const lastEvent = events[events.length - 1];
  if (lastEvent.outcome === 'succeeded') {
    return 'succeeded';
  }
  if (lastEvent.outcome === 'blocked') {
    return 'blocked';
  }
  if (isFailureEvent(lastEvent)) {
    return 'failed';
  }
  if (lastEvent.outcome === 'started') {
    return 'in_progress';
  }
  return 'unknown';
}

function pickFirstDefined<T>(...values: Array<T | undefined>): T | undefined {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function selectLatestArtifact(
  artifacts: RuntimeArtifact[],
  type: RuntimeArtifact['type']
): RuntimeArtifact | undefined {
  for (let index = artifacts.length - 1; index >= 0; index -= 1) {
    if (artifacts[index].type === type) {
      return artifacts[index];
    }
  }
  return undefined;
}

export class ObservationQueryService {
  constructor(private runtimeObservationService: RuntimeObservationService) {}

  async getTraceSummary(traceId: string): Promise<TraceSummary> {
    const events = await this.runtimeObservationService.listEventsByTrace(traceId);
    const artifacts = await this.runtimeObservationService.listArtifactsByTrace(traceId, 10);
    const rootEvent = events[0];
    const lastEvent = events[events.length - 1];
    const firstFailure = events.find((event) => isFailureEvent(event));

    return {
      traceId,
      eventCount: events.length,
      artifactCount: artifacts.length,
      ...(rootEvent ? { startedAt: rootEvent.timestamp } : {}),
      ...(lastEvent ? { finishedAt: lastEvent.timestamp } : {}),
      finalStatus: resolveFinalStatus(events),
      ...(rootEvent ? { rootEvent } : {}),
      ...(lastEvent ? { lastEvent } : {}),
      ...(firstFailure ? { firstFailure } : {}),
      entities: {
        capability: pickFirstDefined(
          rootEvent?.capability,
          firstFailure?.capability,
          lastEvent?.capability
        ),
        pluginId: pickFirstDefined(rootEvent?.pluginId, firstFailure?.pluginId, lastEvent?.pluginId),
        browserEngine: pickFirstDefined(
          rootEvent?.browserEngine,
          firstFailure?.browserEngine,
          lastEvent?.browserEngine
        ),
        sessionId: pickFirstDefined(rootEvent?.sessionId, firstFailure?.sessionId, lastEvent?.sessionId),
        profileId: pickFirstDefined(rootEvent?.profileId, firstFailure?.profileId, lastEvent?.profileId),
        datasetId: pickFirstDefined(rootEvent?.datasetId, firstFailure?.datasetId, lastEvent?.datasetId),
        browserId: pickFirstDefined(rootEvent?.browserId, firstFailure?.browserId, lastEvent?.browserId),
        source: pickFirstDefined(rootEvent?.source, firstFailure?.source, lastEvent?.source),
      },
      recentArtifacts: artifacts.slice(-5).map((artifact) => toArtifactRef(artifact)),
    };
  }

  async getFailureBundle(traceId: string): Promise<FailureBundle> {
    const events = await this.runtimeObservationService.listEventsByTrace(traceId);
    const recentEvents = events.slice(-20);
    const failedEvent = [...events].reverse().find((event) => isFailureEvent(event));
    const fallbackArtifacts = await this.runtimeObservationService.listArtifactsByTrace(traceId, 10);

    const artifactIds = Array.from(
      new Set([
        ...(failedEvent?.artifactRefs || []),
        ...fallbackArtifacts.slice(-4).map((artifact) => artifact.artifactId),
      ])
    );
    const artifacts =
      artifactIds.length > 0
        ? await this.runtimeObservationService.getArtifactsByIds(artifactIds)
        : fallbackArtifacts;

    return {
      traceId,
      ...(failedEvent?.error ? { error: failedEvent.error } : {}),
      ...(failedEvent ? { failedEvent } : {}),
      recentEvents,
      artifactRefs: artifacts.map((artifact) => toArtifactRef(artifact)),
      ...(selectLatestArtifact(artifacts, 'snapshot')
        ? { snapshot: selectLatestArtifact(artifacts, 'snapshot') }
        : {}),
      ...(selectLatestArtifact(artifacts, 'screenshot')
        ? { screenshot: selectLatestArtifact(artifacts, 'screenshot') }
        : {}),
      ...(selectLatestArtifact(artifacts, 'console_tail')
        ? { consoleTail: selectLatestArtifact(artifacts, 'console_tail') }
        : {}),
      ...(selectLatestArtifact(artifacts, 'network_summary')
        ? { networkSummary: selectLatestArtifact(artifacts, 'network_summary') }
        : {}),
      ...(selectLatestArtifact(artifacts, 'error_context')
        ? { errorContext: selectLatestArtifact(artifacts, 'error_context') }
        : {}),
    };
  }

  async getTraceTimeline(traceId: string, limit = 100): Promise<TraceTimeline> {
    const normalizedLimit = Math.max(1, Math.floor(limit || 100));
    const events = await this.runtimeObservationService.listEventsByTrace(traceId, normalizedLimit);
    const artifacts = await this.runtimeObservationService.listArtifactsByTrace(traceId, normalizedLimit);

    return {
      traceId,
      finalStatus: resolveFinalStatus(events),
      events,
      artifactRefs: artifacts.map((artifact) => toArtifactRef(artifact)),
    };
  }

  async searchRecentFailures(limit = 20): Promise<RecentFailureSummary[]> {
    const normalizedLimit = Math.max(1, Math.floor(limit || 20));
    const failedEvents = await this.runtimeObservationService.listRecentFailureEvents(
      normalizedLimit * 4
    );
    const latestByTrace = new Map<string, RuntimeEvent>();

    for (let index = failedEvents.length - 1; index >= 0; index -= 1) {
      const event = failedEvents[index];
      if (!latestByTrace.has(event.traceId)) {
        latestByTrace.set(event.traceId, event);
      }
      if (latestByTrace.size >= normalizedLimit) {
        break;
      }
    }

    const recentFailures = Array.from(latestByTrace.values())
      .sort((left, right) => right.timestamp - left.timestamp)
      .slice(0, normalizedLimit);
    const artifactCounts = await this.runtimeObservationService.getArtifactCountsByTraceIds(
      recentFailures.map((event) => event.traceId)
    );

    return await Promise.all(
      recentFailures.map(async (event) => {
        const summary = await this.getTraceSummary(event.traceId);
        return {
          traceId: event.traceId,
          failedAt: event.timestamp,
          eventId: event.eventId,
          event: event.event,
          component: event.component,
          ...(event.message ? { message: event.message } : {}),
          ...(event.capability ? { capability: event.capability } : {}),
          ...(event.pluginId ? { pluginId: event.pluginId } : {}),
          ...(event.sessionId ? { sessionId: event.sessionId } : {}),
          ...(event.profileId ? { profileId: event.profileId } : {}),
          ...(event.datasetId ? { datasetId: event.datasetId } : {}),
          ...(event.browserId ? { browserId: event.browserId } : {}),
          ...(event.browserEngine ? { browserEngine: event.browserEngine } : {}),
          ...(event.error ? { error: event.error } : {}),
          finalStatus: summary.finalStatus,
          artifactCount: artifactCounts.get(event.traceId) || 0,
        };
      })
    );
  }
}
