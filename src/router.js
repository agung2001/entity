import { createRouter, createWebHashHistory, createWebHistory } from 'vue-router'
import { hub, restoreSession } from '@/stores/hub'
import { loadWorkspaces, workspaces } from '@/stores/workspaces'

import LoginView from '@/views/LoginView.vue'
import SetupView from '@/views/SetupView.vue'
import HubLayout from '@/layouts/HubLayout.vue'
import OverviewView from '@/views/OverviewView.vue'
import ChatView from '@/views/ChatView.vue'
import EntityDetailView from '@/views/EntityDetailView.vue'
import SkillsView from '@/views/SkillsView.vue'
import SkillDetailView from '@/views/SkillDetailView.vue'
import McpView from '@/views/McpView.vue'
import ArtifactDetailView from '@/views/ArtifactDetailView.vue'
import MachinesView from '@/views/MachinesView.vue'
import MachineDetailView from '@/views/MachineDetailView.vue'
import AccountView from '@/views/AccountView.vue'
import AccountProfileView from '@/views/account/AccountProfileView.vue'
import AccountSoundView from '@/views/account/AccountSoundView.vue'
import AccountMcpView from '@/views/account/AccountMcpView.vue'
import WorkspaceView from '@/views/WorkspaceView.vue'

/* Clean URLs wherever an HTTP server can resolve a path. The packaged app
   loads `dist/index.html` over `file://`, where there is no server to answer a
   reload on `/skills/x`, so that mode keeps the hash. */
const history =
  typeof window !== 'undefined' && /^https?:$/.test(window.location.protocol)
    ? createWebHistory()
    : createWebHashHistory()

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
          name: 'overview',
          component: OverviewView,
          meta: { crumb: 'overview', title: 'Overview · entity' },
        },
        {
          path: 'chat',
          name: 'chat',
          component: ChatView,
          meta: { crumb: 'chat', title: 'Chat · entity' },
        },
        {
          path: 'entities/:name',
          name: 'entity',
          component: EntityDetailView,
          meta: { crumb: 'entities', title: 'Entity · entity' },
        },
        {
          path: 'skills',
          name: 'skills',
          component: SkillsView,
          meta: { crumb: 'skills', title: 'Skills · entity' },
        },
        {
          path: 'skills/:name',
          name: 'skill',
          component: SkillDetailView,
          meta: { crumb: 'skills', title: 'Skill · entity' },
        },
        {
          path: 'mcp',
          name: 'mcp',
          component: McpView,
          meta: { crumb: 'mcp', title: 'MCP · entity' },
        },
        {
          path: 'artifacts/:id(.*)',
          name: 'artifact',
          component: ArtifactDetailView,
          meta: { crumb: 'artifact', title: 'Artifact · entity' },
        },
        {
          path: 'machines',
          name: 'machines',
          component: MachinesView,
          meta: { crumb: 'machines', title: 'Machines · entity' },
        },
        {
          path: 'machines/:id',
          name: 'machine',
          component: MachineDetailView,
          meta: { crumb: 'machines', title: 'Machine · entity' },
        },
        {
          /* Activity moved into the Workspace page; keep old links working. */
          path: 'activity',
          redirect: { name: 'workspace', query: { tab: 'activity' } },
        },
        {
          path: 'workspace',
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
              path: 'mcp',
              name: 'account-mcp',
              component: AccountMcpView,
              meta: { crumb: 'account', title: 'MCP server · entity' },
            },
          ],
        },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
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
    return workspaces.items.length ? { name: 'overview' } : { name: 'setup' }
  }

  if (!hub.session) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }

  if (!workspaces.loaded) await loadWorkspaces()

  if (to.name === 'setup') {
    /* the setup screen is for a profile with no workspace; adding another one
       later happens as a modal from the Workspaces panel, not by leaving the hub */
    if (workspaces.items.length) return { name: 'overview' }
    return true
  }

  if (!workspaces.items.length) {
    return { name: 'setup', query: { redirect: to.fullPath } }
  }

  return true
})

router.afterEach((to) => {
  document.title = to.meta.title || 'entity — local agent workspace'
})

export default router
