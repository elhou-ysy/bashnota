<script setup lang="ts">
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/ui/command'
import { 
  Trash2 as Trash2Icon, 
  Scissors as ScissorsIcon, 
  Copy as CopyIcon, 
  Star as StarIcon
} from 'lucide-vue-next'
import { onMounted, onUnmounted, ref, computed, h } from 'vue'
import type { EditorView } from '@tiptap/pm/view'
import { serializeForClipboard } from '@/features/editor/components/extensions/DragHandlePlugin'
import type { Selection } from '@tiptap/pm/state'
import { useFavoriteBlocksStore } from '@/features/nota/stores/favoriteBlocksStore'
import AddToFavoritesModal from '@/features/editor/components/dialogs/AddToFavoritesModal.vue'
import { toast } from '@/ui/toast'
import { logger } from '@/services/logger'
import { useAIActionsStore } from '@/features/ai/stores/aiActionsStore'
import { useAIActions } from '@/features/ai/components/composables/useAIActions'
import { getIconComponent, getColorClasses } from '@/features/ai/utils/iconResolver'

const props = defineProps<{
  position: { x: number; y: number } | null
  selection: Selection | null
  isVisible: boolean
  editorView?: EditorView
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const favoriteBlocksStore = useFavoriteBlocksStore()
const aiActionsStore = useAIActionsStore()
const { isProcessing, executeAction } = useAIActions()

const showAddToFavoritesModal = ref(false)

// Get enabled AI actions with safety checks
const enabledAIActions = computed(() => {
  try {
    // Only return actions if the store is loaded
    if (!aiActionsStore.isLoaded) {
      return []
    }
    
    return aiActionsStore.enabledActions.filter(action => 
      action && 
      action.id && 
      action.name && 
      action.icon && 
      action.color
    )
  } catch (error) {
    logger.error('Error getting enabled AI actions:', error)
    return []
  }
})

const cut = () => {
  emit('close')
  if (!props.editorView || !props.selection) return

  const slice = props.selection.content()
  const { dom, text } = serializeForClipboard(props.editorView, slice)

  // Copy the content to the clipboard
  const clipboardItem = new ClipboardItem({
    'text/html': new Blob([dom.innerHTML], { type: 'text/html' }),
    'text/plain': new Blob([text], { type: 'text/plain' }),
  })

  navigator.clipboard.write([clipboardItem]).then(() => {
    if (!props.editorView || !props.selection) return

    // After copying, delete the selected block
    const { state, dispatch } = props.editorView
    const tr = state.tr.delete(props.selection.from, props.selection.to)
    dispatch(tr)
  })
}

const copy = () => {
  emit('close')
  if (!props.editorView || !props.selection) return

  const slice = props.selection.content()
  const { dom, text } = serializeForClipboard(props.editorView, slice)

  // Copy the content to the clipboard
  const clipboardItem = new ClipboardItem({
    'text/html': new Blob([dom.innerHTML], { type: 'text/html' }),
    'text/plain': new Blob([text], { type: 'text/plain' }),
  })

  navigator.clipboard.write([clipboardItem])
}

const deleteBlock = () => {
  emit('close')
  if (!props.editorView || !props.selection) return

  const { state, dispatch } = props.editorView!
  const tr = state.tr.delete(props.selection.from, props.selection.to)
  dispatch(tr)

  // Focus the editor after deleting
  props.editorView.focus()
}

const addToFavorites = () => {
  showAddToFavoritesModal.value = true
}

const handleAddToFavorites = async (name: string, tags: string[]) => {
  if (!props.editorView || !props.selection) return

  const node = props.editorView.state.doc.nodeAt(props.selection.from)
  if (!node) return

  const nodeType = node.type.name
  const content = node.toJSON()

  try {
    // Ensure content is stringified before saving
    await favoriteBlocksStore.addBlock({
      name,
      content: JSON.stringify(content),
      type: nodeType,
      tags: Array.from(tags) // Ensure tags is a plain array
    })
    
    showAddToFavoritesModal.value = false
    
    toast({
      title: 'Success',
      description: 'Block added to favorites'
    })
    
    emit('close')
    props.editorView.focus()
  } catch (error) {
    logger.error('Failed to add block:', error)
    toast({
      title: 'Error',
      description: 'Failed to add block to favorites',
      variant: 'destructive'
    })
  }
}

// AI-powered functions
const getSelectedText = (): string => {
  if (!props.editorView || !props.selection) return ''
  
  const { from, to } = props.selection
  const text = props.editorView.state.doc.textBetween(from, to, ' ')
  return text.trim()
}

const replaceSelectedText = (newText: string) => {
  if (!props.editorView || !props.selection) return
  
  const { state, dispatch } = props.editorView
  const { from, to } = props.selection
  
  const tr = state.tr.replaceWith(from, to, state.schema.text(newText))
  dispatch(tr)
  
  // Focus the editor after replacing
  props.editorView.focus()
}

const handleAIAction = async (actionId: string) => {
  const action = aiActionsStore.getActionById(actionId)
  if (!action) return
  
  const selectedText = getSelectedText()
  
  await executeAction(action, selectedText, (newText) => {
    replaceSelectedText(newText)
  })
  
  emit('close')
}

// Handle click outside
const handleClickOutside = (event: MouseEvent) => {
  const target = event.target as HTMLElement
  // Check if the click is inside the command menu or the modal
  if (!target.closest('.command-menu') && !target.closest('[role="dialog"]')) {
    emit('close')
  }
}

onMounted(() => {
  document.addEventListener('mousedown', handleClickOutside)
})

onUnmounted(() => {
  document.removeEventListener('mousedown', handleClickOutside)
})
</script>

<template>
  <div>
    <Command
      v-if="isVisible && position"
      class="fixed z-50 rounded-lg border shadow-md w-64 h-auto command-menu bg-popover"
      :style="{
        left: `${position.x}px`,
        top: `${position.y}px`,
      }"
    >
      <CommandList>
        <!-- Standard Actions -->
        <CommandGroup>
          <CommandItem value="cut" @select="cut">
            <ScissorsIcon class="mr-2 h-4 w-4" />
            <span>Cut</span>
          </CommandItem>
          <CommandItem value="copy" @select="copy">
            <CopyIcon class="mr-2 h-4 w-4" />
            <span>Copy</span>
          </CommandItem>
          <CommandItem value="favorite" @select="addToFavorites">
            <StarIcon class="mr-2 h-4 w-4" />
            <span>Add to Favorites</span>
          </CommandItem>
        </CommandGroup>

        <CommandSeparator v-if="aiActionsStore.isLoaded && enabledAIActions.length > 0" />

        <!-- AI-Powered Actions -->
        <CommandGroup v-if="aiActionsStore.isLoaded && enabledAIActions.length > 0">
          <CommandItem 
            v-for="action in enabledAIActions"
            :key="action.id"
            :value="action.id" 
            @select="() => handleAIAction(action.id)"
            :disabled="isProcessing"
            :class="[getColorClasses(action.color || 'blue').text, getColorClasses(action.color || 'blue').hover]"
          >
            <component 
              :is="getIconComponent(action.icon || 'EditIcon')" 
              class="mr-2 h-4 w-4" 
            />
            <span>{{ isProcessing ? 'Processing...' : (action.name || 'AI Action') }}</span>
          </CommandItem>
        </CommandGroup>

        <CommandSeparator v-if="aiActionsStore.isLoaded && enabledAIActions.length > 0" />

        <!-- Destructive Actions -->
        <CommandGroup>
          <CommandItem
            class="text-red-600 hover:bg-red-100 hover:text-red-600"
            value="delete"
            @select="deleteBlock"
          >
            <Trash2Icon class="mr-2 h-4 w-4" />
            <span>Delete</span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>

    <AddToFavoritesModal
      v-model:open="showAddToFavoritesModal"
      @submit="handleAddToFavorites"
    />
  </div>
</template>

<style scoped>
.fixed {
  position: fixed;
}

.command-menu .lucide {
  flex-shrink: 0;
}
</style>








