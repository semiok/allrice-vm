/* global window */
// Use the real installed composition, after the native Host has connected and
// mounted the fixture session. The test provides a synthetic SaaS document.
window.__ModuleLoader__.load({
  id: '@allrice/composition-test-fixture',
  factory: (require) => {
    const product = require('@allrice/dsh-web-composition');
    return {
      inject: [
        'sessions',
        'workspaces',
        'uiWorkspace',
        'theme',
        'conversation',
        'inputTriggers',
      ],
      apply(ctx) {
        let opened = false;
        const nativeSession = 'session-00000000-0000-4000-8000-000000000036';
        const open = () => {
          if (
            opened ||
            ctx.sessions.list.getSnapshot().phase !== 'ready' ||
            ctx.workspaces.list.getSnapshot().phase !== 'ready'
          )
            return;
          opened = true;
          ctx.uiWorkspace.openSession(nativeSession);
          window.__allriceSettingsWorkbench = {
            async mount(markup) {
              const [initial] = ctx.registry.get(product).fibers;
              const parent = initial.parent;
              await initial.dispose();
              window.document.body.insertAdjacentHTML('beforeend', markup);
              const controller = new window.AbortController();
              window.__ALLRICE_D_ENTRY_LIFETIME__ = controller.signal;
              await parent.plugin(product);
            },
            setTheme(mode) {
              ctx.theme.setTheme(mode);
            },
            async references() {
              const binding = ctx.sessions.binding(nativeSession);
              if (!binding) throw Error('Missing native conversation binding');
              const input = ctx.conversation.input
                .for(binding.ctx)
                .state.getSnapshot();
              const codec = ctx.inputTriggers.sessionOf(binding.ctx);
              return Promise.all(
                input.occurrences.map(({ source, ref, label }) =>
                  codec
                    .serializeReference(
                      source,
                      ref,
                      new window.AbortController().signal,
                    )
                    .then((text) => ({ label, text })),
                ),
              );
            },
          };
        };
        ctx.effect(() => {
          const sessions = ctx.sessions.list.subscribe(open);
          const workspaces = ctx.workspaces.list.subscribe(open);
          open();
          return () => {
            sessions();
            workspaces();
            delete window.__allriceSettingsWorkbench;
          };
        });
      },
    };
  },
});
