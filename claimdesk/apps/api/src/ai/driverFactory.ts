/**
 * Driver selection (docs/SUPREME-DESIGN.md §A.1, §A.4, §A.7) — owned by `gateway`.
 *
 * `getDriver(ctx)` picks the driver from AI_DRIVER (cli | api | fake | off) when set, else Settings > AI
 * (`agent_settings.ai.driver`: subscription_cli | api_key | off). The fake driver is refused in a running app unless
 * CLAIMDESK_ALLOW_FAKE_AI=1 (tests may always use it). Real drivers throw REAL_AI_FORBIDDEN when the process forbids
 * real AI. `setDriverOverride(ctx, driver)` lets tests (and the runtime's own tests) inject a driver instance.
 */
import type { AppContext } from '../context.js';
import type { AiDriver, AiRunOutcome, DriverHealth, DriverKind } from './types.js';
import { SubscriptionCliDriver, type SubscriptionCliDriverOptions } from './subscriptionCliDriver.js';
import { ApiKeyDriver, type ApiKeyDriverOptions } from './apiKeyDriver.js';
import { FakeDriver, FakeAiNotAllowedError, type FakeDriverOptions } from './fakeDriver.js';
import { gatewayServices } from './prompts.js';

export type DriverChoice = DriverKind | 'off';

/** A driver that never runs: AI is switched off (the default after install/upgrade). */
export class OffDriver implements AiDriver {
  readonly kind = 'fake' as const;
  readonly off = true;
  constructor(private readonly reason = 'AI is switched off in Settings > AI') {}
  async health(): Promise<DriverHealth> {
    return { kind: this.kind, ready: false, problems: [this.reason] };
  }
  async run(): Promise<AiRunOutcome> {
    return { kind: 'error', retryable: false, code: 'AI_OFF', message: this.reason };
  }
}

interface FactoryOverrides {
  driver?: AiDriver;
  cli?: SubscriptionCliDriverOptions;
  api?: ApiKeyDriverOptions;
  fake?: FakeDriverOptions;
}
const overrides = new WeakMap<AppContext, FactoryOverrides>();
const cache = new WeakMap<AppContext, { key: string; driver: AiDriver }>();

function slot(ctx: AppContext): FactoryOverrides {
  let o = overrides.get(ctx);
  if (!o) {
    o = {};
    overrides.set(ctx, o);
  }
  return o;
}

/** Inject a driver instance (tests); `undefined` clears it. */
export function setDriverOverride(ctx: AppContext, driver: AiDriver | undefined): void {
  slot(ctx).driver = driver;
  cache.delete(ctx);
}
/** Options for the drivers the factory builds (tests: fake claude command, injected fetch, extra fixtures). */
export function setDriverOptions(ctx: AppContext, opts: { cli?: SubscriptionCliDriverOptions; api?: ApiKeyDriverOptions; fake?: FakeDriverOptions }): void {
  Object.assign(slot(ctx), opts);
  cache.delete(ctx);
}
export function cliOptionsFor(ctx: AppContext): SubscriptionCliDriverOptions {
  const o = slot(ctx).cli ?? {};
  const mcpUrl = gatewayServices(ctx).mcpUrl;
  return { ...(mcpUrl ? { mcpUrl } : {}), ...o };
}

/** Which driver is selected: AI_DRIVER first, else Settings > AI. */
export function selectedDriver(ctx: AppContext): DriverChoice {
  switch (ctx.config.aiDriverOverride) {
    case 'cli':
      return 'subscription_cli';
    case 'api':
      return 'api_key';
    case 'fake':
      return 'fake';
    case 'off':
      return 'off';
    default:
      break;
  }
  const d = ctx.repos.getAgentSettings(ctx.db).ai.driver;
  return d === 'subscription_cli' || d === 'api_key' ? d : 'off';
}

/** The driver for the next run. Never throws for 'off'; throws REAL_AI_FORBIDDEN / FAKE_AI_NOT_ALLOWED when refused. */
export function getDriver(ctx: AppContext): AiDriver {
  const o = slot(ctx);
  if (o.driver) return o.driver;
  const choice = selectedDriver(ctx);
  const cached = cache.get(ctx);
  if (cached && cached.key === choice) return cached.driver;
  let driver: AiDriver;
  switch (choice) {
    case 'subscription_cli':
      driver = new SubscriptionCliDriver(ctx, cliOptionsFor(ctx));
      break;
    case 'api_key':
      driver = new ApiKeyDriver(ctx, o.api ?? {});
      break;
    case 'fake':
      if (ctx.config.env !== 'test' && !ctx.config.allowFakeAi) throw new FakeAiNotAllowedError();
      driver = new FakeDriver(ctx, o.fake ?? {});
      break;
    default:
      driver = new OffDriver();
  }
  cache.set(ctx, { key: choice, driver });
  return driver;
}

export function isOffDriver(d: AiDriver): d is OffDriver {
  return (d as Partial<OffDriver>).off === true;
}
