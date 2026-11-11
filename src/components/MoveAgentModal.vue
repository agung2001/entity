<script setup>
import { computed } from 'vue'
import {
  agentById,
  closeMove,
  hub,
  movePackNote,
  startTransfer,
  toggleMoveSkill,
} from '@/stores/hub'

const agent = computed(() => agentById(hub.move.agentId))
const from = computed(() => agent.value?.machines[0] || 'unplaced')

function setTo(e) {
  hub.move.to = e.target.value
}

function start() {
  if (hub.move.finished) {
    closeMove()
    return
  }
  startTransfer()
}
</script>

<template>
  <div
    class="modal"
    :data-open="hub.move.open ? '1' : '0'"
    role="dialog"
    aria-modal="true"
    aria-label="Move entity"
  >
    <template v-if="agent">
      <div class="mo-head">
        <h2>Move {{ agent.name }}</h2>
        <p>Copy the runtime, its skills and ENTITY.md to another machine.</p>
      </div>

      <div class="mo-body">
        <div class="fld">
          <span class="lbl">Route</span>
          <div class="route">
            <div class="end"><small>From</small>{{ from }}</div>
            <span class="arrow">→</span>
            <div class="end" style="padding: 2px 4px">
              <small style="padding-left: 6px">To</small>
              <select aria-label="Target machine" :value="hub.move.to" @change="setTo">
                <option v-for="m in hub.machines" :key="m.id" :value="m.id">{{ m.label }}</option>
              </select>
            </div>
          </div>
        </div>

        <div class="fld">
          <span class="lbl">Skills to carry</span>
          <div class="picks">
            <button
              v-for="s in agent.skills"
              :key="s"
              class="pick"
              type="button"
              :aria-pressed="hub.move.skills.includes(s) ? 'true' : 'false'"
              @click="toggleMoveSkill(s)"
            >
              <i>✓</i>{{ s }}
            </button>
            <span v-if="!agent.skills.length" class="mnote">No skills attached to this entity.</span>
          </div>
        </div>

        <div class="fld" style="margin-bottom: 16px">
          <span class="lbl">Main instructions</span>
          <button
            class="pick"
            type="button"
            :aria-pressed="hub.move.md ? 'true' : 'false'"
            @click="hub.move.md = !hub.move.md"
          >
            <i>✓</i>ENTITY.md
          </button>
          <span class="mnote" style="margin-left: 8px">always sent when present</span>
        </div>

        <div class="progress" :hidden="hub.move.progress === 0 && !hub.move.running">
          <i :style="{ width: hub.move.progress + '%' }"></i>
        </div>

        <p class="mnote">
          {{
            hub.move.running
              ? hub.move.stepNote
              : hub.move.finished
                ? 'manifest verified · skills and ENTITY.md in place'
                : movePackNote()
          }}
        </p>

        <div v-if="hub.move.finished" class="done">
          <span class="g">✓</span>
          <p>
            <b>{{ hub.move.doneTitle }}</b><br />
            {{ hub.move.skills.length }} skill{{
              hub.move.skills.length === 1 ? '' : 's'
            }}
            and ENTITY.md verified. The copy on {{ from }} is still running.
          </p>
        </div>
      </div>

      <div class="mo-foot">
        <button class="btn" :disabled="hub.move.running" @click="closeMove">Cancel</button>
        <button class="btn btn-ink" :disabled="hub.move.running" @click="start">
          {{ hub.move.running ? 'Transferring…' : hub.move.finished ? 'Done' : 'Start transfer' }}
        </button>
      </div>
    </template>
  </div>
</template>
