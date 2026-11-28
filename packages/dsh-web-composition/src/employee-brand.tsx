import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import { employeeColorPalette } from '@allrice/contracts';
import logo from '../../../apps/web/public/brand/allrice-icon-v1.svg';
import {
  employeeChoice,
  sessionEmployeeKey,
} from '../../../apps/web/app/chatflow/employee-instances';
import './employee-brand.css';

const brand = '@allrice/dsh-web-composition/employee-brand';

const languages = {
  zh: {
    id: 'zh-x-allrice',
    label: '简体中文（AllRice）',
    chat: {
      'chat.deepDiving': '思考中',
      'chat.deepDivingFor': '思考中，用时 {duration} ···',
    },
  },
  en: {
    id: 'en-x-allrice',
    label: 'English (AllRice)',
    chat: {
      'chat.deepDiving': 'Thinking',
      'chat.deepDivingFor': 'Thinking for {duration} ···',
    },
  },
} as const;

function EmployeeHero() {
  return (
    <span data-allrice-hero-brand>
      <img src={logo} alt="" width={36} height={36} />
      <span data-allrice-hero-copy>
        <span data-allrice-hero-name>
          AllRice <span data-allrice-preview-badge>预览版</span>
        </span>
        <span data-allrice-hero-slogan>Do it right. Make it nice.</span>
      </span>
    </span>
  );
}

function bindAccent(ctx: Context) {
  const port = ctx.allriceEmployeeSidebar;
  let previous: string | undefined;
  let release: (() => void) | undefined;
  const update = () => {
    const tree = port.getSnapshot()?.tree;
    const session = tree?.sessions.find((item) => item.id === tree.activeId);
    const employee =
      tree && session
        ? employeeChoice(tree.workspace, sessionEmployeeKey(session))
        : undefined;
    const accent = employee?.currentVersion.manifest.appearance?.accentColor;
    const color = (
      employeeColorPalette[
        accent === 'indigo' ? 'blue' : (accent ?? 'amber')
      ] ?? employeeColorPalette.amber
    ).value;
    if (color === previous) return;
    release?.();
    previous = color;
    // rc.2 draws white composer glyphs. Darken the saved color for the button
    // while keeping a much lighter tint on the dark-mode running label.
    release = ctx.theme.overrideTokens(brand, {
      '--dsw-alias-button-info-fill': {
        light: `color-mix(in srgb, ${color} 54%, black)`,
        dark: `color-mix(in srgb, ${color} 54%, black)`,
      },
      '--dsw-alias-button-info-hover': {
        light: `color-mix(in srgb, ${color} 46%, black)`,
        dark: `color-mix(in srgb, ${color} 46%, black)`,
      },
      '--dsw-alias-label-deep-diving': {
        light: `color-mix(in srgb, ${color} 54%, black)`,
        dark: `color-mix(in srgb, ${color} 70%, white)`,
      },
      '--dsw-alias-label-shimmer': {
        light: `color-mix(in srgb, ${color} 72%, black)`,
        dark: `color-mix(in srgb, ${color} 35%, white)`,
      },
      '--dsw-alias-label-deep-diving-shimmer': {
        light: `color-mix(in srgb, ${color} 72%, black)`,
        dark: `color-mix(in srgb, ${color} 35%, white)`,
      },
    });
  };
  update();
  const unsubscribe = port.subscribe(update);
  return () => {
    unsubscribe();
    release?.();
  };
}

/** Presentation for the sealed employee Web profile. The native shell
 * retains its composer, session ownership, settings and accessibility. */
export function apply(ctx: Context) {
  const hero = 'conversation.hero.brand.mark';
  ctx.slots.inject(hero, () =>
    ctx.slots.register({ name: hero, priority: -100 }, EmployeeHero),
  );
  const workspace = 'conversation.hero.workspace';
  ctx.slots.inject(workspace, () =>
    ctx.slots.register({ name: workspace, priority: -100 }, () => (
      <span hidden data-allrice-managed-workspace />
    )),
  );
  const general = 'settings.general.item';
  ctx.slots.inject(general, () =>
    ctx.slots.register(
      { name: general, id: 'current-version', priority: -100 },
      () => null,
    ),
  );

  ctx.inject(['locale', 'configForms'], (scope) => {
    scope.effect(() => {
      const locale = scope.locale;
      const form = scope.configForms.get<{ preference?: string }>('locale');
      const dispose = Object.entries(languages).flatMap(([fallback, pack]) => [
        locale.addLanguage({ id: pack.id, label: pack.label, fallback }),
        locale.register('chat', pack.id, pack.chat),
        locale.register('conversation', pack.id, {
          'hero.headline': '',
          'hero.preview': '',
        }),
      ]);
      const adoptPublishedPreference = () => {
        // The native runtime's interim browser language has no saved
        // preference. Upgrade only a real stock preference after it arrives.
        const preference = form.getSnapshot().value?.preference;
        if (
          (preference === 'zh' || preference === 'en') &&
          locale.getSnapshot().active === preference
        )
          locale.setLocale(languages[preference].id);
      };
      const unsubscribe = form.subscribe(adoptPublishedPreference);
      adoptPublishedPreference();
      return () => {
        unsubscribe();
        dispose.reverse().forEach((remove) => remove());
      };
    }, 'AllRice employee language pack');
  });
  ctx.inject(['allriceEmployeeSidebar'], (scope) => {
    scope.effect(() => bindAccent(scope), 'AllRice current employee accent');
  });

  ctx.effect(() => {
    const title = document.querySelector?.('title');
    if (!title) return () => {};
    // rc.2's native layout has no product-title input. Preserve its session
    // title and replace only its own suffix in this document.
    const update = () => {
      const current = document.title;
      const suffix = ' — DeepSeek Harness';
      if (current === 'DeepSeek Harness') document.title = 'AllRice';
      else if (current.endsWith(suffix))
        document.title = `${current.slice(0, -suffix.length)} — AllRice`;
    };
    const observer = new MutationObserver(update);
    observer.observe(title, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    update();
    return () => observer.disconnect();
  }, 'AllRice employee document title');
}
