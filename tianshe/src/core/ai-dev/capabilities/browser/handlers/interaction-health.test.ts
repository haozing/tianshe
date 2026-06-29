import { ensureInteractionReadyForAction } from './interaction-health';

describe('interaction health', () => {
  it('allows direct-managed sessions with unknown viewport health to proceed', async () => {
    const ensureCurrentSessionInteractionReady = vi.fn();
    const deps = {
      mcpSessionContext: {
        sessionId: 'session-1',
        visible: false,
        viewportHealth: 'unknown',
        viewportHealthReason: 'browser implementation manages visibility directly',
        interactionReady: true,
        offscreenDetected: false,
      },
      mcpSessionGateway: {
        ensureCurrentSessionInteractionReady,
      },
    };

    await expect(
      ensureInteractionReadyForAction(deps as never, {
        tool: 'browser_act',
        action: 'type',
      })
    ).resolves.toBeUndefined();
    expect(ensureCurrentSessionInteractionReady).not.toHaveBeenCalled();
  });

  it('accepts repaired direct-managed sessions returned by the MCP gateway', async () => {
    const ensureCurrentSessionInteractionReady = vi.fn().mockResolvedValue({
      sessionId: 'session-1',
      visible: false,
      hostWindowId: undefined,
      viewportHealth: 'unknown',
      viewportHealthReason: 'browser implementation manages visibility directly',
      interactionReady: true,
      offscreenDetected: false,
      repaired: true,
      browserAcquired: true,
    });
    const deps = {
      mcpSessionContext: {
        sessionId: 'session-1',
        visible: false,
        viewportHealth: 'unknown',
        viewportHealthReason: 'browser view is not available for health inspection',
        interactionReady: false,
        offscreenDetected: false,
      },
      mcpSessionGateway: {
        ensureCurrentSessionInteractionReady,
      },
    };

    await expect(
      ensureInteractionReadyForAction(deps as never, {
        tool: 'browser_act',
        action: 'click',
      })
    ).resolves.toBeUndefined();
    expect(ensureCurrentSessionInteractionReady).toHaveBeenCalledTimes(1);
    expect(deps.mcpSessionContext).toMatchObject({
      viewportHealth: 'unknown',
      viewportHealthReason: 'browser implementation manages visibility directly',
      interactionReady: true,
    });
  });
});
