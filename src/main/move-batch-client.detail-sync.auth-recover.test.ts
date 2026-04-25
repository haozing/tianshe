import { describe, expect, it, vi } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  createMoveBatchClient,
} = require('../../examples/dywebs-detail-sync-worker/lib/move-batch-client.js');

function unauthorizedResponse() {
  return {
    ok: true,
    status: 200,
    json: { retCode: '1501', retMsg: '登录超时，请重新登录' },
    textPreview: '',
  };
}

function successResponse() {
  return {
    ok: true,
    status: 200,
    json: { retCode: '0', retMsg: 'ok' },
    textPreview: '',
  };
}

describe('dywebs-detail-sync-worker dycopy auth recover', () => {
  it('waits for doudian login, reopens dycopy home, and then authorizes', async () => {
    const dycopyHomeUrl = 'https://dywebs.xingtaosoft.com/move/batch';
    const authorizeUrl = 'https://fuwu.jinritemai.com/authorize?service_id=25190';
    const loginUrl =
      'https://fxg.jinritemai.com/login/common?next=' +
      encodeURIComponent(`${authorizeUrl}&loginType=1`);

    let phase:
      | 'home_unauthorized'
      | 'login_wait'
      | 'after_login_landing'
      | 'home_after_login'
      | 'authorize'
      | 'authorized' = 'home_unauthorized';
    let loginPolls = 0;

    const clickedTexts: string[] = [];
    const gotoUrls: string[] = [];

    const browser = {
      goto: vi.fn(async (url: string) => {
        gotoUrls.push(String(url || ''));
        const target = String(url || '');
        if (target.startsWith(authorizeUrl)) {
          if (phase === 'home_unauthorized' || phase === 'home_after_login') {
            phase = 'login_wait';
          }
          return;
        }
        if (target.startsWith(dycopyHomeUrl)) {
          if (
            phase === 'after_login_landing' ||
            phase === 'login_wait' ||
            phase === 'home_unauthorized'
          ) {
            phase = 'home_after_login';
          }
        }
      }),
      getCurrentUrl: vi.fn(async () => {
        if (phase === 'home_unauthorized' || phase === 'home_after_login' || phase === 'authorized') {
          return dycopyHomeUrl;
        }
        if (phase === 'authorize' || phase === 'after_login_landing') {
          return authorizeUrl;
        }
        return loginUrl;
      }),
      getWindowOpenPolicy: vi.fn(() => null),
      setWindowOpenPolicy: vi.fn(),
      clearWindowOpenPolicy: vi.fn(),
      snapshot: vi.fn(async () => {
        if (phase === 'home_unauthorized' || phase === 'home_after_login') {
          return { elements: [{ name: '重新授权' }] };
        }
        if (phase === 'authorize') {
          return {
            elements: [
              {
                name: '确认授权 授权即代表您已阅读并同意 抖店开放平台授权协议',
              },
            ],
          };
        }
        if (phase === 'login_wait') {
          return {
            elements: [
              {
                name: '巨量引擎账号 手机登录 验证码 登录 我已阅读并同意 服务协议 隐私条款',
              },
            ],
          };
        }
        return { elements: [] };
      }),
      clickText: vi.fn(async (text: string) => {
        const value = String(text || '');
        clickedTexts.push(value);
        if (phase === 'login_wait') {
          throw new Error(`should not click login page button: ${value}`);
        }
        if (phase === 'home_after_login' && value.includes('重新授权')) {
          phase = 'authorize';
          return;
        }
        if (
          phase === 'authorize' &&
          (value.includes('确认授权') ||
            value.includes('同意授权') ||
            value.includes('继续授权') ||
            value === '授权')
        ) {
          phase = 'authorized';
        }
      }),
      evaluate: vi.fn(async (script: string) => {
        const source = String(script || '');

        if (source.includes('fetch(input.url')) {
          return phase === 'authorized' ? successResponse() : unauthorizedResponse();
        }

        if (source.includes('localStoreShopId') && source.includes('sessionStorage')) {
          return {
            shopId: 'shop-1',
            source: 'localStorage.localStoreShopId',
            candidates: [{ value: 'shop-1', score: 120, source: 'localStorage.localStoreShopId' }],
          };
        }

        if (source.includes('const loginHints =')) {
          const currentUrl = await browser.getCurrentUrl();
          if (phase === 'login_wait') {
            loginPolls += 1;
            if (loginPolls >= 2) phase = 'after_login_landing';
            return {
              url: loginUrl,
              title: '抖店登录-抖店后台-抖音电商后台',
              isDoudianLoginPage: true,
              isAuthorizePage: false,
              hasLoginForm: true,
              hasLoginButton: true,
              hasAuthorizeButton: false,
            };
          }
          if (phase === 'authorize' || phase === 'after_login_landing') {
            return {
              url: authorizeUrl,
              title: '抖店服务市场-授权',
              isDoudianLoginPage: false,
              isAuthorizePage: true,
              hasLoginForm: false,
              hasLoginButton: false,
              hasAuthorizeButton: true,
            };
          }
          return {
            url: currentUrl,
            title: '抖音张飞搬家-1688复制',
            isDoudianLoginPage: false,
            isAuthorizePage: false,
            hasLoginForm: false,
            hasLoginButton: false,
            hasAuthorizeButton: phase === 'home_after_login',
          };
        }

        if (source.includes('const headerRight =')) {
          const currentUrl = await browser.getCurrentUrl();
          return {
            ok: true,
            loggedIn: phase !== 'login_wait',
            url: currentUrl,
            title:
              phase === 'login_wait'
                ? '抖店登录-抖店后台-抖音电商后台'
                : '抖音张飞搬家-1688复制',
            hasHeaderRight: phase !== 'login_wait',
            hasUserBox: phase !== 'login_wait',
            hasUserNameNode: phase !== 'login_wait',
            userNameText: phase !== 'login_wait' ? '店铺A' : '',
            hasAmountNode: phase !== 'login_wait',
            hasQuotaNode: phase !== 'login_wait',
            hasQuotaTrigger: phase !== 'login_wait',
            quotaText: phase !== 'login_wait' ? '剩余额度' : '',
            amountText: phase !== 'login_wait' ? '剩余额度' : '',
            bodyHasQuotaText: phase !== 'login_wait',
            hasRemainingQuota: phase !== 'login_wait',
            hasCopyStats: false,
            hasSwitchShopButton: false,
            hasReauthorizeButton: phase === 'home_unauthorized' || phase === 'home_after_login',
            hasReloginButton: false,
            hasAuthorizeHint: phase === 'home_unauthorized' || phase === 'home_after_login',
            hasReloginHint: false,
          };
        }

        if (source.includes("strategy: 'force'")) {
          if (phase === 'authorize') {
            phase = 'authorized';
            return {
              strategy: 'force',
              stage: 'authorize_page',
              clickedRelogin: false,
              checkedAgreement: true,
              clickedAuthorize: true,
              clickedTexts: ['确认授权'],
            };
          }
          return {
            strategy: 'force',
            stage: 'none',
            clickedRelogin: false,
            checkedAgreement: false,
            clickedAuthorize: false,
            clickedTexts: [],
          };
        }

        if (source.includes('const dialogRoots =')) {
          return {
            strategy: 'dom',
            stage: 'none',
            clickedRelogin: false,
            checkedAgreement: false,
            clickedAuthorize: false,
            clickedTexts: [],
          };
        }

        throw new Error(`unexpected evaluate path: ${source.slice(0, 80)}`);
      }),
    };

    const client = createMoveBatchClient({
      browser,
      onLog: async () => {},
    });

    const result = await client.ensureDycopyAuth({
      maxRetry: 1,
      verifyIntervalMs: 20,
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(true);
    expect(result.autoRecover?.clickedAuthorize).toBe(true);
    expect(gotoUrls.some((url) => url.startsWith(dycopyHomeUrl))).toBe(true);
    expect(clickedTexts.some((text) => text.includes('重新授权'))).toBe(true);
    expect(clickedTexts).not.toContain('登录');
  });
});
