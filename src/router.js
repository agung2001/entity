import { createRouter, createWebHashHistory, createWebHistory } from 'vue-router'
import { hub, restoreSession } from '@/stores/hub'
import { loadWorkspaceList, loadWorkspaces, openWorkspace, workspaces } from '@/stores/workspaces'

/* Every screen is its own chunk: the sign-in page does not download the chat,
   the chat does not download the MCP inventory, and a workspace that is never
   opened costs nothing. The guard below awaits the session and workspace calls,
   so these fetches overlap with that work instead of blocking it. */
const LoginView = () => import('@/views/LoginView.vue')
const WelcomeView = () => import('@/views/WelcomeView.vue')
const HubLayout = () => import('@/layouts/HubLayout.vue')
const OverviewView = () => import('@/views/OverviewView.vue')
const ChatView = () => import('@/views/ChatView.vue')
const EntitiesView = () => import('@/views/EntitiesView.vue')
const EntityDetailView = () => import('@/views/EntityDetailView.vue')
const SkillsView = () => import('@/views/SkillsView.vue')
const SkillDetailView = () => import('@/views/SkillDetailView.vue')
const ConnectorPageView = () => import('@/views/ConnectorPageView.vue')
const ArtifactsIndexView = () => import('@/views/ArtifactsIndexView.vue')
const ArtifactDetailView = () => import('@/views/ArtifactDetailView.vue')
const MachinesView = () => import('@/views/MachinesView.vue')
const NewsView = () => import('@/views/NewsView.vue')
const MachineDetailView = () => import('@/views/MachineDetailView.vue')
const AccountView = () => import('@/views/AccountView.vue')
const AccountProfileView = () => import('@/views/account/AccountProfileView.vue')
const AccountSoundView = () => import('@/views/account/AccountSoundView.vue')
const AccountNotificationsView = () => import('@/views/account/AccountNotificationsView.vue')
const AccountHarnessView = () => import('@/views/account/AccountHarnessView.vue')
const AccountBackupView = () => import('@/views/account/AccountBackupView.vue')
const AccountUpdateView = () => import('@/views/account/AccountUpdateView.vue')
const WorkspaceView = () => import('@/views/WorkspaceView.vue')
const ManageWorkspacesView = () => import('@/views/ManageWorkspacesView.vue')

/* Clean URLs wherever an HTTP server can resolve a path. The packaged app
   loads `dist/index.html` over `file://`, where there is no server to answer a
   reload on `/skills/x`, so that mode keeps the hash. */
const history =
  typeof window !== 'undefined' && /^https?:$/.test(window.location.protocol)
    ? createWebHistory()
    : createWebHashHistory()

function rememberedWorkspace() {
  if (workspaces.active) return workspaces.active
  try {
    return localStorage.getItem('entity.workspace') || ''
  } catch {
    return ''
  }
}

/* Old flat links keep working by resolving to the active workspace's prefixed
   route. New links pass the workspace id explicitly. */
function legacy(name, extra = {}) {
  return (to) => {
    const workspace = rememberedWorkspace()
    if (!workspace) return { name: 'workspaces' }
    return {
      name,
      params: { workspace, ...(extra.params?.(to) || {}) },
      query: { ...to.query, ...(extra.query || {}) },
      hash: to.hash,
    }
  }
}

const router = createRouter({
  history,
  routes: [
    {
      path: '/login',
      name: 'login',
      component: LoginView,
      meta: { public: true, title: 'Sign in · entity' },
    },
    {
      /* the first run: three steps, no account, no folder yet. Public because
         there is nothing to sign in to — the wizard creates the account. It is
         also the only surface that creates a workspace, so a session with no
         room on disk is sent back here rather than to a second setup page. */
      path: '/welcome',
      name: 'welcome',
      component: WelcomeView,
      meta: { public: true, title: 'Welcome · entity' },
    },
    {
      path: '/',
      component: HubLayout,
      children: [
        {
          path: '',
          redirect: { name: 'workspaces' },
        },
        {
          path: 'overview',
          name: 'legacy-overview',
          redirect: legacy('overview'),
        },
        {
          path: 'chat',
          name: 'legacy-chat',
          redirect: legacy('chat'),
        },
        {
          path: 'entities/:name',
          name: 'legacy-entity',
          redirect: legacy('entity', { params: (to) => ({ name: to.params.name }) }),
        },
        {
          path: 'skills',
          name: 'legacy-skills',
          redirect: legacy('skills'),
        },
        {
          path: 'skills/:name',
          name: 'legacy-skill',
          redirect: legacy('skill', { params: (to) => ({ name: to.params.name }) }),
        },
        {
          path: 'mcp',
          name: 'legacy-mcp',
          redirect: legacy('mcp'),
        },
        {
          path: 'artifacts/:id(.*)',
          name: 'legacy-artifact',
          redirect: legacy('artifact', { params: (to) => ({ id: to.params.id }) }),
        },
        {
          path: 'machines',
          name: 'legacy-machines',
          redirect: legacy('machines'),
        },
        {
          path: 'machines/:id',
          name: 'legacy-machine',
          redirect: legacy('machine', { params: (to) => ({ id: to.params.id }) }),
        },
        {
          path: 'activity',
          name: 'legacy-activity',
          redirect: legacy('workspace', { query: { tab: 'activity' } }),
        },
        {
          path: 'workspace',
          name: 'legacy-workspace',
          redirect: legacy('workspace'),
        },
        {
          path: 'workspaces',
          name: 'workspaces',
          component: ManageWorkspacesView,
          meta: { crumb: 'workspaces', title: 'Workspaces · entity' },
        },
        {
          path: ':workspace',
          redirect: (to) => ({ name: 'overview', params: { workspace: to.params.workspace } }),
        },
        {
          path: ':workspace/overview',
          name: 'overview',
          component: OverviewView,
          meta: { crumb: 'overview', title: 'Overview · entity' },
        },
        {
          path: ':workspace/chat',
          name: 'chat',
          component: ChatView,
          meta: { crumb: 'chat', title: 'Chat · entity' },
        },
        {
          path: ':workspace/news',
          name: 'news',
          component: NewsView,
          /* `rail: false` is the page saying it has no second tier. Without it the
             shell draws one and the rail falls back to a section — which is how
             the machine list ended up beside a list of headlines. */
          meta: { crumb: 'news', title: 'News · entity', rail: false },
        },
        {
          /* The index is a sibling **above** the detail route: `:name` would
             otherwise swallow the bare path and send `entities` to a page
             looking for an entity called nothing. */
          path: ':workspace/entities',
          name: 'entities',
          component: EntitiesView,
          meta: { crumb: 'entities', title: 'Entities · entity' },
        },
        {
          path: ':workspace/entities/:name',
          name: 'entity',
          component: EntityDetailView,
          meta: { crumb: 'entities', title: 'Entity · entity' },
        },
        {
          path: ':workspace/skills',
          name: 'skills',
          component: SkillsView,
          meta: { crumb: 'skills', title: 'Skills · entity' },
        },
        {
          path: ':workspace/skills/:name',
          name: 'skill',
          component: SkillDetailView,
          meta: { crumb: 'skills', title: 'Skill · entity' },
        },
        {
          /* Connectors is a page of its own and a tab of Workspace settings: the
             named route lands on the settings page's tab, so a deep link, a rail
             row and the redirect from Account all arrive at one address. */
          path: ':workspace/connectors',
          name: 'connectors',
          redirect: (to) => ({
            name: 'workspace',
            params: { workspace: to.params.workspace },
            query: { ...to.query, tab: 'connectors' },
          }),
          meta: { crumb: 'connectors', title: 'Connectors · entity' },
        },
        {
          /* The bulk MCP list is the Connectors roster now. This address keeps
             working as a redirect — the rail's MCP tab, old links and the
             `:workspace/mcp/:name` page it used to lead to all still resolve. */
          path: ':workspace/mcp',
          name: 'mcp',
          redirect: (to) => ({
            name: 'workspace',
            params: { workspace: to.params.workspace },
            query: { ...to.query, tab: 'connectors' },
          }),
          meta: { crumb: 'connectors', title: 'Connectors · entity' },
        },
        {
          /* One connector's own page, whatever its kind. An MCP server and a cli
             row are two rows of one roster, so they are two kinds of one address
             — `connectors/:id` was already the detail route and `mcp/:name` was
             the odd one out. The view is chosen by `kind`, not by route order:
             a name both kinds could hold must not depend on which object the
             router matched first. `:workspace/mcp/:name` survives as a redirect
             below so old links keep landing. */
          path: ':workspace/connectors/:id',
          name: 'connector-page',
          component: ConnectorPageView,
          meta: { crumb: 'connectors', title: 'Connector · entity' },
        },
        {
          /* The MCP server page's old address. A server is a connector row like
             any other now; this is a permanent redirect, not a second route. */
          path: ':workspace/mcp/:name',
          name: 'mcp-server',
          redirect: (to) => ({
            name: 'connector-page',
            params: { workspace: to.params.workspace, id: to.params.name },
            query: to.query,
          }),
          meta: { crumb: 'connectors', title: 'Connector · entity' },
        },
        {
          /* The shelf itself, above the file page: `artifact` owns
             `:workspace/artifacts/:id(.*)`, which also swallows `/artifacts`, so
             the index has to be declared first and win on its own address. */
          path: ':workspace/artifacts',
          name: 'artifacts',
          component: ArtifactsIndexView,
          meta: { crumb: 'artifacts', title: 'Artifacts · entity' },
        },
        {
          path: ':workspace/artifacts/:id(.*)',
          name: 'artifact',
          component: ArtifactDetailView,
          meta: { crumb: 'artifact', title: 'Artifact · entity' },
        },
        {
          path: ':workspace/machines',
          name: 'machines',
          component: MachinesView,
          meta: { crumb: 'machines', title: 'Machines · entity' },
        },
        {
          path: ':workspace/machines/:id',
          name: 'machine',
          component: MachineDetailView,
          meta: { crumb: 'machines', title: 'Machine · entity' },
        },
        {
          path: ':workspace/activity',
          redirect: (to) => ({
            name: 'workspace',
            params: { workspace: to.params.workspace },
            query: { ...to.query, tab: 'activity' },
          }),
        },
        {
          path: ':workspace/settings',
          name: 'workspace',
          component: WorkspaceView,
          meta: { crumb: 'workspace', title: 'Workspace · entity' },
        },
        {
          path: 'account',
          component: AccountView,
          meta: { crumb: 'account' },
          children: [
            {
              path: '',
              name: 'account',
              component: AccountProfileView,
              meta: { crumb: 'account', title: 'Account · entity' },
            },
            {
              path: 'sound',
              name: 'account-sound',
              component: AccountSoundView,
              meta: { crumb: 'account', title: 'Sound · entity' },
            },
            {
              path: 'notifications',
              name: 'account-notifications',
              component: AccountNotificationsView,
              meta: { crumb: 'account', title: 'Notifications · entity' },
            },
            {
              /* The merged page lives in the workspace, because a connector's
                 definition does: deep links and old habits keep working through a
                 redirect, and nothing 404s. */
              path: 'mcp',
              name: 'account-mcp',
              redirect: (to) => ({
                name: 'connectors',
                params: { workspace: rememberedWorkspace() },
                query: to.query,
              }),
              meta: { crumb: 'account', title: 'MCP server · entity' },
            },
            {
              path: 'harnesses',
              name: 'account-harnesses',
              component: AccountHarnessView,
              meta: { crumb: 'account', title: 'Harnesses · entity' },
            },
            {
              path: 'integrations',
              name: 'account-integrations',
              redirect: (to) => ({
                name: 'connectors',
                params: { workspace: rememberedWorkspace() },
                query: to.query,
              }),
              meta: { crumb: 'account', title: 'Integrations · entity' },
            },
            {
              path: 'backups',
              name: 'account-backups',
              component: AccountBackupView,
              meta: { crumb: 'account', title: 'Backups · entity' },
            },
            {
              path: 'updates',
              name: 'account-updates',
              component: AccountUpdateView,
              meta: { crumb: 'account', title: 'Updates · entity' },
            },
          ],
        },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: '/workspaces' },
  ],
})

/**
 * Guard order: session → workspace → route.
 *
 * The workspace trigger is the directory on disk (`workspace.needsSetup()`), not
 * a flag someone has to remember to set, so a fresh profile — or a workspace
 * deleted outside the app — lands on /welcome every time. The deep link the user
 * was trying to reach travels in `?redirect` and is honoured after sign-in.
 */
router.beforeEach(async (to) => {
  /* A remembered session is only trusted after auth.json agrees with it. */
  await restoreSession()

  if (to.meta.public) {
    /* Session first, even here: a live session never sees either public door. */
    if (hub.session) {
      /* The wizard stays reachable for a session with no room on disk — it is
         the only surface that creates one. Anything else has a hub to open, so
         the answer has to come from disk, not from an unloaded store. */
      if (!workspaces.loaded && !workspaces.items.length) {
        await loadWorkspaceList().catch(() => {})
      }
      if (to.name === 'welcome' && !workspaces.items.length) return true
      if (to.name !== 'login' && to.name !== 'welcome') return true
      /* a live session does not need the sign-in screen again */
      if (!workspaces.loaded) await loadWorkspaces()
      return { name: 'workspaces' }
    }
    /* No session: the disk decides. A workspace on disk is a sign-in (/login),
       no workspace at all is the first run (/welcome). */
    if (!workspaces.loaded && !workspaces.items.length) {
      await loadWorkspaceList().catch(() => {})
    }
    if (!workspaces.items.length) return to.name === 'welcome' ? true : { name: 'welcome' }
    return to.name === 'welcome' ? { name: 'login' } : true
  }

  if (!hub.session) {
    if (!workspaces.loaded && !workspaces.items.length) {
      await loadWorkspaceList().catch(() => {})
    }
    return workspaces.items.length
      ? { name: 'login', query: { redirect: to.fullPath } }
      : { name: 'welcome' }
  }

  if (!workspaces.loaded) await loadWorkspaces()

  if (!workspaces.items.length) return { name: 'welcome' }

  const wanted = String(to.params.workspace || '')
  if (wanted) {
    if (!workspaces.items.some((item) => item.id === wanted)) {
      return { name: 'workspaces' }
    }
    if (workspaces.active !== wanted) {
      try {
        await openWorkspace(wanted)
      } catch {
        return { name: 'workspaces' }
      }
    }
  }

  return true
})

router.afterEach((to) => {
  document.title = to.meta.title || 'entity — local agent workspace'
})

export default router
