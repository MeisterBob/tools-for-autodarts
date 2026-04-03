<template>
  <div v-if="guide.length > 0" class="flex flex-wrap gap-2">
    <span v-for="(dart, index) in guide" :key="index"
      class="px-3 py-1 rounded-md bg-white/15 text-white/90 text-sm font-medium transition-all duration-200 backdrop-blur-sm">
      {{ dart }}
    </span>
  </div>
</template>

<script setup lang="ts">
import type { IGameData } from "@/utils/game-data-storage";
import { AutodartsToolsGameData } from "@/utils/game-data-storage";

const props = defineProps<{
  playerIndex: number;
}>();

const guide = ref<Array<string>>([]);

onMounted(() => {
  guide.value = [];

  const unwatch = AutodartsToolsGameData.watch((gameData: IGameData) => {
    const match = gameData.match!;
    if (!match?.gameScores || (match.turns[0].turn === 0 && match.turnScore === 0)) {
      guide.value = [];
      return;
    }
    if (match.player !== props.playerIndex)
      return;

    guide.value = [];
    guide.value = match.state.checkoutGuide.map((e) => e.name);
  });

  onUnmounted(() => {
    if (typeof unwatch === 'function') {
      unwatch();
    }
  });
});
</script>
