export interface ServiceToken<T> {
  readonly id: string;
  readonly description?: string;
  readonly __type?: T;
}

export interface ServiceRegistrationOptions<T> {
  dispose?: (service: T) => void | Promise<void>;
}

export interface LifecycleService {
  readonly dependencies?: readonly ServiceToken<unknown>[];
  start?(): void | Promise<void>;
  stop?(): void | Promise<void>;
  readiness?(): unknown;
}

interface ServiceRegistration<T> {
  readonly token: ServiceToken<T>;
  readonly service: T;
  readonly dispose?: (service: T) => void | Promise<void>;
}

export function createServiceToken<T>(
  id: string,
  description?: string
): ServiceToken<T> {
  return {
    id,
    ...(description ? { description } : {}),
  };
}

export class ServiceContainer {
  private readonly registrations = new Map<string, ServiceRegistration<unknown>>();

  register<T>(
    token: ServiceToken<T>,
    service: T,
    options: ServiceRegistrationOptions<T> = {}
  ): T {
    if (this.registrations.has(token.id)) {
      throw new Error(`Service "${token.id}" is already registered`);
    }

    this.registrations.set(token.id, {
      token,
      service,
      dispose: options.dispose as ((service: unknown) => void | Promise<void>) | undefined,
    });

    return service;
  }

  has(token: ServiceToken<unknown>): boolean {
    return this.registrations.has(token.id);
  }

  get<T>(token: ServiceToken<T>): T {
    const registration = this.registrations.get(token.id);
    if (!registration) {
      throw new Error(`Service "${token.id}" has not been registered`);
    }
    return registration.service as T;
  }

  getOptional<T>(token: ServiceToken<T>): T | null {
    const registration = this.registrations.get(token.id);
    return registration ? (registration.service as T) : null;
  }

  async dispose(token: ServiceToken<unknown>): Promise<void> {
    const registration = this.registrations.get(token.id);
    if (!registration) return;

    this.registrations.delete(token.id);
    if (registration.dispose) {
      await registration.dispose(registration.service);
      return;
    }

    const lifecycleService = registration.service as Partial<LifecycleService>;
    if (typeof lifecycleService.stop === 'function') {
      await lifecycleService.stop();
    }
  }

  async disposeAll(): Promise<void> {
    const tokens = Array.from(this.registrations.values())
      .map((registration) => registration.token)
      .reverse();

    for (const token of tokens) {
      await this.dispose(token);
    }
  }
}
