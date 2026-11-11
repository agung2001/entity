import { createRouter, createWebHashHistory } from 'vue-router'
import { hub } from '@/stores/hub'

import LoginView from '@/views/LoginView.vue'
import HubLayout from '@/layouts/HubLayout.vue'
import OverviewView from '@/views/OverviewView.vue'
import ChatView from '@/views/ChatView.vue'
import EntitiesView from '@/views/EntitiesView.vue'
import SkillsView from '@/views/SkillsView.vue'
import SkillDetailView from '@/views/SkillDetailView.vue'
import MachinesView from '@/views/MachinesView.vue'
import ActivityView from '@/views/ActivityView.vue'

/* Hash history: the packaged app loads over `file://`, where history mode has
   no server to resolve a path on reload. */
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: LoginView,
      meta: { public: true, title: 'Sign in · entity' },
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
          path: 'entities',
          name: 'entities',
          component: EntitiesView,
          meta: { crumb: 'entities', title: 'Entities · entity' },
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
          path: 'machines',
          name: 'machines',
          component: MachinesView,
          meta: { crumb: 'machines', title: 'Machines · entity' },
        },
        {
          path: 'activity',
          name: 'activity',
          component: ActivityView,
          meta: { crumb: 'activity', title: 'Activity · entity' },
        },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

router.beforeEach((to) => {
  if (to.meta.public) {
    /* a live session does not need the sign-in screen again */
    if (to.name === 'login' && hub.session) return { name: 'overview' }
    return true
  }
  if (!hub.session) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }
  return true
})

router.afterEach((to) => {
  document.title = to.meta.title || 'entity'
})

export default router
