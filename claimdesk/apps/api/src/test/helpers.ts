import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../app.js';
import { testConfig } from '../config.js';
import { buildContext, silentLogger, type AppContext } from '../context.js';

export interface TestApp {
  app: FastifyInstance;
  ctx: AppContext;
  /** Frozen clock — tests advance it with `setNow`. */
  setNow(iso: string): void;
  api<T = unknown>(method: InjectOptions['method'], url: string, payload?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: T }>;
  close(): Promise<void>;
}

export async function createTestApp(now = '2026-10-05T09:00:00.000Z'): Promise<TestApp> {
  let current = now;
  const ctx = buildContext({ config: testConfig(), now: () => current, logger: silentLogger });
  const app = await buildApp(ctx);
  await app.ready();
  return {
    app,
    ctx,
    setNow: (iso) => {
      current = iso;
    },
    async api(method, url, payload, headers) {
      const res = await app.inject({ method, url: `/api${url}`, payload: payload as InjectOptions['payload'], headers });
      const text = res.body;
      let body: unknown = text;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        /* non-JSON body */
      }
      return { status: res.statusCode, body: body as never };
    },
    close: () => app.close(),
  };
}

export const FNOL = {
  claimant: { kind: 'individual', name: 'Amina Yusuf', phone: '07700 900123', email: 'amina@example.com', address: { line1: '12 High Street', town: 'Reading', postcode: 'RG1 1AA' }, roles: ['claimant', 'driver'] },
  vehicle: { registration: 'KX21 ABC', make: 'Toyota', model: 'Yaris', yearOfManufacture: 2021, fuelType: 'hybrid', ownership: 'client' },
  thirdPartyVehicle: { registration: 'LM19 XYZ', make: 'Ford', model: 'Transit', ownership: 'third_party' },
  atFaultInsurer: { kind: 'company', name: 'Example Insurance plc', roles: ['insurer'] },
  accident: {
    occurredAt: '2026-10-03T08:15:00.000Z',
    location: 'A329 London Road, Reading',
    circumstances: 'I was stationary in traffic when the van behind failed to stop and struck the rear of my car. The driver apologised at the scene.',
    cctvAvailable: true,
    independentWitness: false,
    injuries: false,
    driveable: false,
  },
  liability: 'unknown',
  callRecordingDisclosed: true,
} as const;
