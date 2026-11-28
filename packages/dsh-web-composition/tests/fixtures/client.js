/* global window */
// Browser-test package only. This file is excluded from the product tarball.
window.__ModuleLoader__.load({
  id: '@allrice/composition-test-fixture',
  factory: (require) => ({
    inject: ['sessions', 'workspaces', 'uiWorkspace', 'theme', 'slots'],
    apply(ctx) {
      ctx.effect(() => {
        const product = require('@allrice/dsh-web-composition');
        const listeners = new Set();
        const threads = [
          { id: 'fixture-gold', employeeAssignmentId: 'gold' },
          { id: 'fixture-orange', employeeAssignmentId: 'orange' },
        ];
        const employees = [
          ['gold', '虚拟哥', 'amber'],
          ['orange', '文章哥', 'orange'],
        ].map(([id, name, accentColor]) => ({
          id,
          currentVersion: {
            id: `${id}-definition`,
            manifest: { name, appearance: { accentColor } },
          },
        }));
        const fixtureWorkspace = {
          organizationId: 'fixture-org',
          workspaceId: 'fixture-workspace',
          viewerId: 'fixture-person',
          employees,
          employeeProfiles: [],
          sessionModels: [],
        };
        let snapshot = null;
        product.bindEmployeeSidebar(ctx, {
          getSnapshot: () => snapshot,
          createEmployee() {},
          openArchive() {},
          openEmployeeSettings() {},
          subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        });
        const test = {
          async startSession(cwd) {
            const { workspaceId } = await ctx.workspaces.create({ path: cwd });
            const id = await ctx.sessions.create({ workspaceId });
            ctx.uiWorkspace.openSession(id);
          },
          selectFixtureEmployee(id) {
            snapshot = {
              settingsOpen: false,
              tree: {
                activeId: `fixture-${id}`,
                sessions: threads.map((thread) => ({
                  ...thread,
                  title: '测试对话',
                  updatedAt: '2026-11-28T00:00:00Z',
                  archivedAt: null,
                })),
                workspace: { ...fixtureWorkspace, employees },
                onNewSession() {},
                onDetails() {},
                onEmployeeNavigate() {},
                onSelectSession() {},
                onNavigate() {},
              },
            };
            listeners.forEach((listener) => listener());
          },
          openSession: (id) => ctx.uiWorkspace.openSession(id),
          setTheme: (mode) => ctx.theme.setTheme(mode),
        };
        let opened = false;
        const open = () => {
          if (
            opened ||
            ctx.sessions.list.getSnapshot().phase !== 'ready' ||
            ctx.workspaces.list.getSnapshot().phase !== 'ready'
          )
            return;
          opened = true;
          ctx.uiWorkspace.openSession(
            'session-00000000-0000-4000-8000-000000000036',
          );
          window.__allriceCompositionTest = test;
        };
        const sessions = ctx.sessions.list.subscribe(open);
        const workspaces = ctx.workspaces.list.subscribe(open);
        open();
        return () => {
          sessions();
          workspaces();
          if (window.__allriceCompositionTest === test)
            delete window.__allriceCompositionTest;
        };
      });
    },
  }),
});
