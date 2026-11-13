import { createRouter, createWebHashHistory, createWebHistory } from 'vue-router'
import { hub, restoreSession } from '@/stores/hub'
import { loadWorkspaces, openWorkspace, workspaces } from '@/stores/workspaces'

/* Every screen is its own chunk: the sign-in page does not download the chat,
   the chat does not download the MCP inventory, and a workspace that is never
   opened costs nothing. The guard below awaits the session and workspace calls,
   so these fetches overlap with that work instead of blocking it. */
const LoginView = () => import('@/views/LoginView.vue')
const SetupView = () => import('@/views/SetupView.vue')
const HubLayout = () => import('@/layouts/HubLayout.vue')
const OverviewView = () => import('@/views/OverviewView.vue')
const ChatView = () => import('@/views/ChatView.vue')
const EntityDetailView = () => import('@/views/EntityDetailView.vue')
const SkillsView = () => import('@/views/SkillsView.vue')
const SkillDetailView = () => import('@/views/SkillDetailView.vue')
const McpView = () => import('@/views/McpView.vue')
const McpServerView = () => import('@/views/McpServerView.vue')
const ArtifactDetailView = () => import('@/views/ArtifactDetailView.vue')
const MachinesView = () => import('@/views/MachinesView.vue')
const MachineDetailView = () => import('@/views/MachineDetailView.vue')
const AccountView = () => import('@/views/AccountView.vue')
const AccountProfileView = () => import('@/views/account/AccountProfileView.vue')
const AccountSoundView = () => import('@/views/account/AccountSoundView.vue')
const AccountNotificationsView = () => import('@/views/account/AccountNotificationsView.vue')
const AccountMcpView = () => import('@/views/account/AccountMcpView.vue')
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
      /* outside HubLayout on purpose: the rail assumes a workspace exists */
      path: '/setup',
      name: 'setup',
      component: SetupView,
      meta: { title: 'Create a workspace · entity' },
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
          path: ':workspace/mcp',
          name: 'mcp',
          component: McpView,
          meta: { crumb: 'mcp', title: 'MCP · entity' },
        },
        {
          path: ':workspace/mcp/:name',
          name: 'mcp-server',
          component: McpServerView,
          meta: { crumb: 'mcp', title: 'MCP server · entity' },
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
              path: 'mcp',
              name: 'account-mcp',
              component: AccountMcpView,
              meta: { crumb: 'account', title: 'MCP server · entity' },
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
 * deleted outside the app — lands on /setup every time. The deep link the user
 * was trying to reach travels in `?redirect` and is honoured after creation.
 */
router.beforeEach(async (to) => {
  /* A remembered session is only trusted after auth.json agrees with it. */
  await restoreSession()

  if (to.meta.public) {
    if (to.name !== 'login' || !hub.session) return true
    /* a live session does not need the sign-in screen again */
    if (!workspaces.loaded) await loadWorkspaces()
    return workspaces.items.length ? { name: 'workspaces' } : { name: 'setup' }
  }

  if (!hub.session) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }

  if (!workspaces.loaded) await loadWorkspaces()

  if (to.name === 'setup') {
    /* the setup screen is for a profile with no workspace; adding another one
       later happens as a modal from the workspace picker, not by leaving the hub */
    if (workspaces.items.length) return { name: 'workspaces' }
    return true
  }

  if (!workspaces.items.length) {
    return { name: 'setup', query: { redirect: to.fullPath } }
  }

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
