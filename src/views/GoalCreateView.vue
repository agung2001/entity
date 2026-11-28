<script setup>
/**
 * The create step's page: the sub-nav and the write (§F2).
 *
 * The wizard owns the fields; the view owns the store and the route, so a refusal
 * from `goals.create` lands beside the button that caused it and nothing is
 * created twice.
 */
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import GoalBackdrop from '@/components/goal/GoalBackdrop.vue'
import GoalCreate from '@/components/goal/GoalCreate.vue'
import GoalsSubnav from '@/components/goal/GoalsSubnav.vue'
import { hub } from '@/stores/hub'
import { createGoal } from '@/stores/goals'

const route = useRoute()
const router = useRouter()

const workspace = computed(() => String(route.params.workspace || hub.workspace || ''))
const initialSentence = computed(() => String(route.query.sentence || ''))
const initialTitle = computed(() => String(route.query.title || ''))

async function save(payload) {
  const answer = await createGoal(
    { ...payload, owner: String(hub.session?.email || '') },
    workspace.value,
  )
  await router.push({ name: 'goal', params: { workspace: workspace.value, id: answer.goal.id } })
}

function cancel() {
  router.push({ name: 'goals', params: { workspace: workspace.value } })
}
</script>

<template>
  <div class="view detail-view">
    <GoalsSubnav />
    <div class="goals-page goals-create">
      <GoalBackdrop />
      <GoalCreate
        :save="save"
        :initial-sentence="initialSentence"
        :initial-title="initialTitle"
        @cancel="cancel"
      />
    </div>
  </div>
</template>
