<script setup>
import { useRoute, useRouter } from 'vue-router'
import EntityMark from '@/components/EntityMark.vue'
import WorkspaceWizard from '@/components/WorkspaceWizard.vue'
import { toast } from '@/stores/hub'

/**
 * First run. The hub is not usable without a workspace, so this screen replaces
 * it entirely rather than rendering an empty shell with a button in every view.
 * No rail, no skip — quitting is allowed and the wizard returns next launch,
 * because the trigger is the directory on disk, not a flag.
 */
const route = useRoute()
const router = useRouter()

function landed(record) {
  toast(`${record.label} is ready`)
  const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/'
  router.replace(redirect && redirect !== '/setup' ? redirect : '/')
}
</script>

<template>
  <main class="auth setup">
    <div class="stack">
      <div class="bouncer">
        <EntityMark class="mark-lg" hop />
      </div>
      <section class="auth-card setup-card">
        <WorkspaceWizard mode="page" @created="landed" />
      </section>
      <p class="meta">
        <span class="copyright">Local only · nothing leaves this machine</span>
      </p>
    </div>
  </main>
</template>
