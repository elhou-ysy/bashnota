<script setup lang="ts">
import { useEditor, EditorContent } from '@tiptap/vue-3'
import { TagsInput } from '@/ui/tags-input'
import { RotateCw, CheckCircle, Star, Share2, Download, PlayCircle, Loader2, Save, Clock, Sparkles, Book, Server, Tag, Link2 } from 'lucide-vue-next'
import { useNotaStore } from '@/features/nota/stores/nota'
import { useJupyterStore } from '@/features/jupyter/stores/jupyterStore'
import EditorToolbar from './ui/EditorToolbar.vue'
import { ref, watch, computed, onUnmounted, onMounted, reactive, provide } from 'vue'
import 'highlight.js/styles/github.css'
import { useRouter } from 'vue-router'
import LoadingSpinner from '@/ui/LoadingSpinner.vue'
import TableOfContents from './ui/TableOfContents.vue'
import JupyterServersSidebar from '@/features/jupyter/components/JupyterServersSidebar.vue'
import { Button } from '@/ui/button'
import { ScrollArea } from '@/ui/scroll-area'
import { BookIcon, ServerIcon, BrainIcon } from 'lucide-vue-next'
import { useCodeExecutionStore } from '@/features/editor/stores/codeExecutionStore'
import { getURLWithoutProtocol, toast } from '@/lib/utils'
import VersionHistoryDialog from './dialogs/VersionHistoryDialog.vue'
import FavoriteBlocksSidebar from '@/features/nota/components/FavoriteBlocksSidebar.vue'
import ReferencesSidebar from '@/features/nota/components/ReferencesSidebar.vue'
import AIAssistantSidebar from '@/features/ai/components/AIAssistantSidebar.vue'
import { getEditorExtensions } from './extensions'
import { useEquationCounter, EQUATION_COUNTER_KEY } from '@/features/editor/composables/useEquationCounter'
import { useCitationStore } from '@/features/editor/stores/citationStore'
import { logger } from '@/services/logger'
import MetadataSidebar from '@/features/nota/components/MetadataSidebar.vue'
import { useDebounceFn } from '@vueuse/core'
import BlockCommandMenu from "./ui/BlockCommandMenu.vue";
import type { Nota } from "@/features/nota/types/nota";
import type { Editor } from "@tiptap/vue-3";
import type { CitationEntry } from "@/features/nota/types/nota";

// Define sidebar types for better type checking
type SidebarPosition = 'left' | 'right';
type SidebarId = 'toc' | 'references' | 'jupyter' | 'ai' | 'metadata' | 'favorites';

interface SidebarConfig {
  isOpen: boolean;
  storageKey: string;
  position: SidebarPosition;
  title: string;
  minWidth?: number;
  maxWidth?: number;
  defaultWidth?: number;
  icon?: any; // Add icon property
}

type SidebarsConfig = Record<SidebarId, SidebarConfig>;

// Sidebar management composable
const useSidebarManager = () => {
  // Define sidebar configurations with default values
  const sidebars = reactive<SidebarsConfig>({
    toc: {
      isOpen: false,
      storageKey: 'toc-sidebar-width',
      position: 'left',
      title: 'Table of Contents',
      icon: null
    },
    references: {
      isOpen: false,
      storageKey: 'references-sidebar-width',
      position: 'right',
      title: 'References',
      icon: BookIcon
    },
    jupyter: {
      isOpen: false,
      storageKey: 'jupyter-sidebar-width',
      position: 'right',
      title: 'Jupyter Servers',
      icon: ServerIcon
    },
    ai: {
      isOpen: false,
      storageKey: 'ai-sidebar-width',
      position: 'right',
      title: 'AI Assistant',
      icon: BrainIcon
    },
    metadata: {
      isOpen: false,
      storageKey: 'metadata-sidebar-width',
      position: 'right',
      title: 'Metadata',
      icon: Tag
    },
    favorites: {
      isOpen: false,
      storageKey: 'favorites-sidebar-width',
      position: 'right',
      title: 'Favorite Blocks',
      icon: Star
    }
  });

  // Toggle a specific sidebar and close others
  const toggleSidebar = (id: SidebarId): void => {
    // Get current state of the selected sidebar
    const currentState = sidebars[id].isOpen;
    
    // Close all sidebars first
    (Object.keys(sidebars) as SidebarId[]).forEach(key => {
      sidebars[key].isOpen = false;
    });
    
    // Toggle the selected sidebar (open if it was closed, keep closed if it was open)
    sidebars[id].isOpen = !currentState;
  };

  // Close all sidebars
  const closeAllSidebars = (): void => {
    (Object.keys(sidebars) as SidebarId[]).forEach(key => {
      sidebars[key].isOpen = false;
    });
  };

  return {
    sidebars,
    toggleSidebar,
    closeAllSidebars
  };
};

// Import shared CSS
import '@/assets/editor-styles.css'

const props = defineProps<{
  notaId: string
  extensions?: any[]
  canRunAll?: boolean
  isExecutingAll?: boolean
  isFavorite?: boolean
}>()

const emit = defineEmits<{
  saving: [boolean]
  'run-all': []
  'toggle-favorite': []
  share: []
  'open-config': []
  'export-nota': []
}>()

const notaStore = useNotaStore()
const jupyterStore = useJupyterStore()
const codeExecutionStore = useCodeExecutionStore()
const citationStore = useCitationStore()
const router = useRouter()
const autoSaveEnabled = ref(true)
const showVersionHistory = ref(false)

// New ref for tracking if shared session mode toggle is in progress
const isTogglingSharedMode = ref(false)

// Add ref to track last saved content
const lastSavedContent = ref<string>('')

// Add debounced save function
const debouncedSave = useDebounceFn(async () => {
  if (!editor.value) return;
  
  try {
    emit('saving', true);
    const content = editor.value.getJSON();

    // Only register code cells if content has changed
    const currentContent = JSON.stringify(content);
    if (currentContent !== lastSavedContent.value) {
      lastSavedContent.value = currentContent;
      registerCodeCells(content, props.notaId);
    }

    // Save sessions whenever content updates
    await codeExecutionStore.saveSessions(props.notaId);

    await notaStore.saveNota({
      id: props.notaId,
      content: JSON.stringify(content),
      updatedAt: new Date(),
    });
  } catch (error) {
    logger.error('Error saving content:', error);
  } finally {
    emit('saving', false);
  }
}, 1000);

const { sidebars, toggleSidebar, closeAllSidebars } = useSidebarManager()

const currentNota = computed(() => {
  return notaStore.getCurrentNota(props.notaId)
})

const content = computed(() => {
  // Insert the title as the first block if not present
  if (!currentNota.value) return null
  let doc
  try {
    doc = currentNota.value.content ? JSON.parse(currentNota.value.content) : null
  } catch (e) {
    doc = null
  }
  if (!doc || !doc.content || !Array.isArray(doc.content)) {
    doc = { type: 'doc', content: [] }
  }
  // Ensure first block is h1 with title
  if (!doc.content.length || doc.content[0].type !== 'heading' || doc.content[0].attrs?.level !== 1) {
    doc.content.unshift({
      type: 'heading',
      attrs: { level: 1 },
      content: [{ type: 'text', text: currentNota.value.title || 'Untitled' }]
    })
  } else if (doc.content[0].content?.[0]?.text !== currentNota.value.title) {
    doc.content[0].content = [{ type: 'text', text: currentNota.value.title || 'Untitled' }]
  }
  return doc
})

const registerCodeCells = (content: any, notaId: string) => {
  // Find all executable code blocks in the content
  const findCodeBlocks = (node: any): any[] => {
    const blocks = []
    if (node.type === 'executableCodeBlock') {
      blocks.push(node)
    }
    if (node.content) {
      node.content.forEach((child: any) => {
        blocks.push(...findCodeBlocks(child))
      })
    }
    return blocks
  }

  const codeBlocks = findCodeBlocks(content)
  const servers = jupyterStore.jupyterServers

  // Register each code block with the store
  codeBlocks.forEach((block) => {
    const { attrs, content } = block
    const code = content ? content.map((c: any) => c.text).join('\n') : ''

    const serverID = attrs.serverID ? getURLWithoutProtocol(attrs.serverID).split(':') : null
    const server = serverID
      ? servers.find(
        (s: any) => getURLWithoutProtocol(s.ip) === serverID[0] && s.port === serverID[1],
      )
      : undefined

    codeExecutionStore.addCell({
      id: attrs.id,
      code,
      serverConfig: server,
      kernelName: attrs.kernelName,
      output: attrs.output,
      sessionId: attrs.sessionId,
    })
  })
}

const editorSettings = reactive({
  fontSize: 16,
  lineHeight: 1.6,
  spellCheck: true,
  tabSize: 2,
  indentWithTabs: false,
  wordWrap: true,
  dragHandleWidth: 24,
  autoSave: true,
})

// Get our shared extensions from the extensions module
const editorExtensions = getEditorExtensions()

const editor = useEditor({
  content: content.value,
  extensions: editorExtensions,
  editorProps: {
    attributes: {
      class: 'prose prose-sm sm:prose lg:prose-lg xl:prose-2xl mx-auto focus:outline-none',
    },
    handlePaste: (view, event) => {
      // Get the plain text content
      const text = event.clipboardData?.getData('text/plain')

      // If there's no text, let the default handler work
      if (!text) return false

      // Check if it looks like markdown
      const isMarkdown =
        /(\#{1,6}\s.+)|(\*\*.+\*\*)|(\*.+\*)|(\[.+\]\(.+\))|(\`\`\`.+\`\`\`)|(\>\s.+)|(\-\s.+)|(\d+\.\s.+)/m.test(
          text,
        )

      if (isMarkdown) {
        // Get the editor instance to use its markdown parsing capability
        const editorInstance = editor.value

        if (editorInstance) {
          // Prevent the default paste behavior
          event.preventDefault()

          // Use the Markdown extension's parsing capability directly
          // This delays the processing to let the editor handle it properly
          setTimeout(() => {
            // First delete the selection if there is one
            if (view.state.selection.from !== view.state.selection.to) {
              editorInstance.commands.deleteSelection()
            }

            // Now insert the markdown as HTML content to trigger proper parsing
            editorInstance.commands.insertContent(text, {
              parseOptions: {
                preserveWhitespace: 'full',
              },
            })
          }, 0)

          return true
        }
      }

      // Let the default handler work for non-markdown content
      return false
    },
  },
  onCreate({ editor }) {
    // Load saved sessions first
    codeExecutionStore.loadSavedSessions(props.notaId)

    // Then register code cells which will associate them with sessions
    const content = editor.getJSON()
    lastSavedContent.value = JSON.stringify(content)
    registerCodeCells(content, props.notaId)

    // Update citation numbers
    updateCitationNumbers()

    editor.view.dom.addEventListener('click', (event) => {
      const target = event.target as HTMLElement
      // Find the closest link element (either the target or its parent)
      const linkElement = target.tagName === 'A' ? target : target.closest('a')
      if (linkElement) {
        event.preventDefault()
        const href = linkElement.getAttribute('href')
        if (href?.startsWith('/nota/')) {
          router.push(href)
        }
      }
    })
    isLoading.value = false
  },
  onUpdate: () => {
    // Use debounced save to prevent too frequent updates
    debouncedSave()
  },
})

// Use a single unified width for all sidebars, but don't set a default
// This allows the sidebars to use their natural width
const unifiedSidebarWidth = ref<number | null>(null);

// Initialize sidebar width tracking for resize events
const sidebarWidths = reactive<Record<SidebarId, number>>({
  toc: unifiedSidebarWidth.value ?? 300,
  references: unifiedSidebarWidth.value ?? 300,
  jupyter: unifiedSidebarWidth.value ?? 300,
  ai: unifiedSidebarWidth.value ?? 300,
  metadata: unifiedSidebarWidth.value ?? 300,
  favorites: unifiedSidebarWidth.value ?? 300
})

// Setup unified persistence for sidebar widths
const updateSidebarWidth = (sidebarId: SidebarId, width: number) => {
  // Update the unified width for all sidebars
  unifiedSidebarWidth.value = width;
  
  // Update all sidebar widths to match
  Object.keys(sidebarWidths).forEach(key => {
    sidebarWidths[key as SidebarId] = width;
  });
  
  // Store in localStorage
  localStorage.setItem('unified-sidebar-width', String(width));
}

// Watch for ID changes to update editor content
watch(
  [() => props.notaId],
  ([newNotaId]) => {
    if (editor.value) {
      if (newNotaId) {
        const nota = notaStore.getCurrentNota(newNotaId)
        editor.value.commands.setContent(nota?.content || '')
      }
    }
  },
  { immediate: true },
)

// Watch for content changes to reset the equation counter
watch(() => content.value, () => {
  // Reset the equation counter when the content changes
  resetEquationCounter()
})

// Watch for sidebar state changes and save to localStorage
  watch(() => sidebars, () => {
  try {
    // Create a simplified object with just the open/closed state of each sidebar
    const sidebarStates = Object.entries(sidebars).reduce<Record<string, boolean>>((acc, [key, sidebar]) => {
      acc[key] = sidebar.isOpen
      return acc
    }, {})
    
    // Save to localStorage
    localStorage.setItem('sidebar-states', JSON.stringify(sidebarStates))
  } catch (error) {
    logger.error('Failed to save sidebar states', error)
  }
}, { deep: true })

const isLoading = ref(true)

const wordCount = computed(() => {
  if (!editor.value) return 0
  const text = editor.value.getText()
  return text.split(/\s+/).filter((word) => word.length > 0).length
})

// Function to apply settings to the editor
function applyEditorSettings(settings = editorSettings) {
  if (!editor.value) return

  // Apply settings to editor
  editor.value.setOptions({
    editorProps: {
      attributes: {
        class: `prose prose-sm sm:prose lg:prose-lg xl:prose-2xl mx-auto focus:outline-none editor-font-size-${settings.fontSize}`,
        spellcheck: settings.spellCheck.toString(),
      },
    },
  })

  // Update CSS variables for the editor
  const editorElement = document.querySelector('.ProseMirror') as HTMLElement
  if (editorElement) {
    const cssVars = {
      '--editor-font-size': `${settings.fontSize}px`,
      '--editor-line-height': settings.lineHeight.toString(),
      '--editor-tab-size': settings.tabSize.toString(),
      '--drag-handle-width': `${settings.dragHandleWidth}px`,
      '--word-wrap': settings.wordWrap ? 'break-word' : 'normal',
    }

    Object.entries(cssVars).forEach(([key, value]) => {
      editorElement.style.setProperty(key, value)
    })
  }

  // Update auto-save behavior
  autoSaveEnabled.value = settings.autoSave
}

const isSaving = ref(false)
const showSaved = ref(false)

// Optimize toggleSharedSessionMode
const toggleSharedSessionMode = async () => {
  if (isTogglingSharedMode.value) return;
  
  isTogglingSharedMode.value = true;
  try {
    const isEnabled = await codeExecutionStore.toggleSharedSessionMode(props.notaId);
    const message = isEnabled 
      ? 'Shared kernel session mode enabled. All code blocks will use the same session.'
      : 'Manual session mode enabled. Each code block can use its own session.';
    toast(message);
  } catch (error) {
    logger.error('Failed to toggle shared session mode:', error);
    toast('Failed to toggle shared session mode');
  } finally {
    isTogglingSharedMode.value = false;
  }
};

// Handle keyboard shortcuts for inserting blocks and toggling sidebars
const handleKeyboardShortcuts = (event: KeyboardEvent) => {
  // Check if editor is initialized
  if (!editor.value) return;

  // Skip if target is a CodeMirror editor
  if (event.target instanceof HTMLElement) {
    const isCodeMirrorFocused = event.target.closest('.cm-editor') !== null;
    if (isCodeMirrorFocused) return;
  }

  // Only process Ctrl+Shift+Alt combinations
  if (!(event.ctrlKey && event.shiftKey && event.altKey)) return;

  // Prevent default browser behavior
  event.preventDefault();

  // Map of key to insertion functions
  const insertionMap: Record<string, () => void> = {
    // Content insertion shortcuts
    c: () =>
      editor
        .value!.chain()
        .focus()
        .insertContent({
          type: 'executableCodeBlock',
          attrs: { language: 'python' },
        })
        .run(),
    t: () =>
      editor.value!.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
    m: () =>
      editor
        .value!.chain()
        .focus()
        .insertContent({
          type: 'mathBlock',
          attrs: { latex: '' },
        })
        .run(),
    y: () =>
      editor.value!.chain().focus().setYoutube('https://www.youtube.com/watch?v=dQw4w9WgXcQ').run(),
    f: () => editor.value!.chain().focus().setSubfigure().run(),
    h: () => editor.value!.chain().focus().setHorizontalRule().run(),
    q: () => editor.value!.chain().focus().toggleBlockquote().run(),
    k: () => editor.value!.chain().focus().toggleTaskList().run(),
    g: () => editor.value!.chain().focus().insertDrawIo().run(),
    b: () => {
      if (currentNota.value?.id) {
        editor.value!.chain().focus().insertNotaTable(currentNota.value.id).run();
      }
    },
    a: () => editor.value!.chain().focus().insertInlineAIGeneration().run(),
    x: () => {
      if (editor.value) {
        editor.value.chain()
          .focus()
          .command(({ tr, dispatch }) => {
            if (dispatch) {
              const node = editor.value!.schema.nodes.paragraph.create(
                null,
                editor.value!.schema.text('New text block')
              );
              tr.insert(tr.doc.content.size, node);
            }
            return true;
          })
          .run();
      }
    },
    
    // Sidebar toggle shortcuts
    r: () => toggleSidebar('references'),
    j: () => toggleSidebar('jupyter'),
    i: () => toggleSidebar('ai'),       // i for AI/intelligence
    v: () => toggleSidebar('favorites'), // v for favorites
    o: () => toggleSidebar('toc'),      // o for outline/toc
    l: () => toggleSidebar('metadata'),  // l for labels/metadata
  };

  const key = event.key.toLowerCase();
  if (insertionMap[key]) {
    insertionMap[key]();
  }
};

// Listen for custom event to open AI sidebar
onMounted(() => {
  if (editor.value) {
    editor.value.on('toggle-ai-sidebar', () => {
      toggleSidebar('ai')
    })
  }

  // Add keyboard shortcut event listener
  document.addEventListener('keydown', handleKeyboardShortcuts)

  // Load unified sidebar width from localStorage
  const savedWidth = localStorage.getItem('unified-sidebar-width');
  if (savedWidth) {
    const width = parseInt(savedWidth, 10);
    if (!isNaN(width)) {
      unifiedSidebarWidth.value = width;
      // Update all sidebar widths
      Object.keys(sidebarWidths).forEach(key => {
        sidebarWidths[key as SidebarId] = width;
      });
    }
  }
  
  // Add event listener for activating AI Assistant
  window.addEventListener('activate-ai-assistant', ((event: CustomEvent) => {
    if (event.detail) {
      // Always open the AI sidebar when triggered from an inline AI generation block
      sidebars.ai.isOpen = true;
      
      // No need to toggle here since we always want to open it
      // This prevents the sidebar from closing when clicking on the same block multiple times
    }
  }) as EventListener)

  // Add event listener for opening Jupyter sidebar from confusion matrix blocks
  window.addEventListener('open-jupyter-sidebar', (() => {
    // Open the Jupyter sidebar
    sidebars.jupyter.isOpen = true;
  }) as EventListener)

  // Load saved sidebar states and widths
  try {
    // Load sidebar open/closed states from localStorage
    const savedSidebarStates = localStorage.getItem('sidebar-states')
    if (savedSidebarStates) {
      const states = JSON.parse(savedSidebarStates)
      Object.keys(states).forEach(key => {
        if (sidebars[key as SidebarId]) {
          sidebars[key as SidebarId].isOpen = states[key]
        }
      })
    }

    // Load sidebar widths from interface settings
    const savedInterfaceSettings = localStorage.getItem('interface-settings')
    if (savedInterfaceSettings) {
      const settings = JSON.parse(savedInterfaceSettings)
      if (settings.sidebarWidths) {
        // Apply saved widths to our tracking state
        Object.entries(settings.sidebarWidths).forEach(([key, width]) => {
          if (sidebarWidths[key as SidebarId]) {
            sidebarWidths[key as SidebarId] = width as number
            
            // Also update defaultWidth in sidebar config if exists
            if (sidebars[key as SidebarId]) {
              sidebars[key as SidebarId].defaultWidth = width as number
            }
          }
        })
      } 
      // Legacy support for older format
      else if (settings.sidebarWidth && settings.sidebarWidth[0]) {
        // Set default width for toc sidebar from legacy setting
        sidebarWidths.toc = settings.sidebarWidth[0] as number
        if (sidebars.toc) {
          sidebars.toc.defaultWidth = settings.sidebarWidth[0] as number
        }
      }
    }
  } catch (error) {
    logger.error('Failed to load sidebar states or widths', error)
  }

  // Load saved editor settings
  const savedEditorSettings = localStorage.getItem('editor-settings')
  if (savedEditorSettings) {
    try {
      const settings = JSON.parse(savedEditorSettings)
      const settingsMap = {
        fontSize: (val: any) => (val && val[0] ? val[0] : undefined),
        lineHeight: (val: any) => (val && val[0] ? val[0] : undefined),
        spellCheck: (val: any) => (val !== undefined ? val : undefined),
        tabSize: (val: any) => (val && val[0] ? val[0] : undefined),
        indentWithTabs: (val: any) => (val !== undefined ? val : undefined),
        wordWrap: (val: any) => (val !== undefined ? val : undefined),
        dragHandleWidth: (val: any) => (val && val[0] ? val[0] : undefined),
        autoSave: (val: any) => (val !== undefined ? val : undefined),
      }

      Object.entries(settingsMap).forEach(([key, transform]) => {
        const value = transform(settings[key])
        if (value !== undefined) {
          ; (editorSettings as any)[key] = value
        }
      })

      applyEditorSettings()
    } catch (e) {
      logger.error('Failed to parse saved editor settings', e)
    }
  }

  // Listen for settings changes with the same mapping logic
  window.addEventListener('editor-settings-changed', ((event: CustomEvent) => {
    if (event.detail) {
      const settingsMap = {
        fontSize: (val: any) => (val && val[0] ? val[0] : undefined),
        lineHeight: (val: any) => (val && val[0] ? val[0] : undefined),
        spellCheck: (val: any) => (val !== undefined ? val : undefined),
        tabSize: (val: any) => (val && val[0] ? val[0] : undefined),
        indentWithTabs: (val: any) => (val !== undefined ? val : undefined),
        wordWrap: (val: any) => (val !== undefined ? val : undefined),
        dragHandleWidth: (val: any) => (val && val[0] ? val[0] : undefined),
        autoSave: (val: any) => (val !== undefined ? val : undefined),
      }

      let hasChanges = false
      Object.entries(settingsMap).forEach(([key, transform]) => {
        const value = transform(event.detail[key])
        if (value !== undefined) {
          ; (editorSettings as any)[key] = value
          hasChanges = true
        }
      })

      if (hasChanges) {
        applyEditorSettings()
      }
    }
  }) as EventListener)
})

onUnmounted(() => {
  if (editor.value) {
    // Remove the event listener
    editor.value.off('toggle-ai-sidebar')
  }

  // Clean up event listeners
  document.removeEventListener('keydown', handleKeyboardShortcuts)
  window.removeEventListener('toggle-references', (() => { }) as EventListener)
  window.removeEventListener('activate-ai-assistant', (() => { }) as EventListener)
  window.removeEventListener('open-jupyter-sidebar', (() => { }) as EventListener)
  codeExecutionStore.cleanup()
})

const isSavingVersion = ref(false)

const saveVersion = async () => {
  if (!editor.value || !currentNota.value) return

  try {
    isSavingVersion.value = true
    const content = editor.value.getJSON()
    await notaStore.saveNotaVersion({
      id: props.notaId,
      content: JSON.stringify(content),
      versionName: `Version ${new Date().toLocaleString()}`,
      createdAt: new Date(),
    })
    toast('Version saved successfully')
  } catch (error) {
    logger.error('Error saving version:', error)
    toast('Failed to save version')
  } finally {
    isSavingVersion.value = false
  }
}
const refreshEditorContent = async () => {
  if (editor.value) {
    // Reload the nota content
    const nota = await notaStore.loadNota(props.notaId)
    if (nota?.content) {
      // Set the editor content from the restored version
      editor.value.commands.setContent(JSON.parse(nota.content))
    }
  }
}

const insertSubNotaLink = (subNotaId: string, subNotaTitle: string) => {
  if (editor.value) {
    // Create a link to the sub-nota
    editor.value
      .chain()
      .focus()
      .setLink({
        href: `/nota/${subNotaId}`,
        target: '_self',
      })
      .insertContent(subNotaTitle)
      .run()

    // Save the content after inserting the link
    debouncedSave()
  }
}

const createAndLinkSubNota = async (title: string) => {
  if (!editor.value) return

  try {
    // Create the sub-nota
    const newNota = await notaStore.createItem(title, props.notaId)

    // Insert a link to the new nota at current cursor position
    insertSubNotaLink(newNota.id, newNota.title)

    return newNota
  } catch (error) {
    logger.error('Error creating sub-nota:', error)
    toast('Failed to create sub-nota')
  }
}

// Setup equation counter
const { counters, reset: resetEquationCounter } = useEquationCounter()

// Provide the equation counter to all child components
provide(EQUATION_COUNTER_KEY, {
  counters,
  getNumber: (id: string) => {
    if (!counters.has(id)) {
      const nextNumber = counters.size + 1
      counters.set(id, nextNumber)
    }
    return counters.get(id) || 0
  },
  reset: resetEquationCounter
})

// Add renderMath state for toggling math rendering
const renderMath = ref(true)

// Expose this state to components
provide('renderMath', renderMath)

// Function to update citation numbers
const updateCitationNumbers = () => {
  if (!editor.value) return

  // Get all citations in the current nota
  const notaCitations = citationStore.getCitationsByNotaId(props.notaId)

  // Create a map of citation keys to their numbers
  const citationMap = new Map()
  notaCitations.forEach((citation: CitationEntry, index: number) => {
    citationMap.set(citation.key, index + 1)
  })

  // Find all citation nodes in the document
  editor.value.state.doc.descendants((node, pos) => {
    if (node.type.name === 'citation') {
      const citationKey = node.attrs.citationKey
      const citationNumber = citationMap.get(citationKey)

      if (citationNumber !== undefined && citationNumber !== node.attrs.citationNumber) {
        // Update the citation number if it has changed
        editor.value?.commands.command(({ tr }) => {
          tr.setNodeMarkup(pos, undefined, {
            ...node.attrs,
            citationNumber
          })
          return true
        })
      }
    }
    return true
  })
}

// Watch for changes in citations and update numbers
watch(() => citationStore.getCitationsByNotaId(props.notaId), () => {
  updateCitationNumbers()
}, { deep: true })

defineExpose({
  insertSubNotaLink,
  createAndLinkSubNota,
})

</script>

<template>
  <div class="h-full w-full flex overflow-hidden">
    <!-- Loading spinner -->
    <LoadingSpinner v-if="isLoading" class="absolute inset-0 z-10" />

    <!-- Table of Contents Sidebar -->
    <div 
      v-if="sidebars.toc.isOpen"
      class="left-sidebar-container"
    >
      <!-- Sidebar Header -->
      <div class="py-1 px-2 border-b flex items-center justify-between">
        <div class="flex items-center">
          <svg class="h-3.5 w-3.5 text-primary mr-1" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            <rect x="9" y="3" width="6" height="4" rx="1" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M9 12h6M9 16h6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <h3 class="text-sm font-medium">{{ sidebars.toc.title }}</h3>
        </div>
        <Button variant="ghost" size="icon" class="h-5 w-5 -mr-1" @click="toggleSidebar('toc')">
          <svg 
            xmlns="http://www.w3.org/2000/svg" 
            width="24" 
            height="24" 
            viewBox="0 0 24 24" 
            fill="none" 
            stroke="currentColor" 
            stroke-width="2" 
            stroke-linecap="round" 
            stroke-linejoin="round" 
            class="w-3 h-3"
          >
            <path d="M18 6 6 18"></path>
            <path d="m6 6 12 12"></path>
          </svg>
        </Button>
      </div>
      
      <!-- Sidebar Content -->
      <div class="flex-1 flex flex-col relative overflow-hidden w-full h-full p-0 m-0">
        <TableOfContents :editor="editor" />
      </div>
    </div>

    <!-- Main Editor Area -->
    <div class="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
      <!-- Editor Toolbar -->
      <div class="border-b bg-background sticky top-0 z-10">
        <EditorToolbar v-if="editor" :editor="editor" class="px-4 py-2" :can-run-all="canRunAll"
          :is-executing-all="isExecutingAll" @run-all="$emit('run-all')" :is-favorite="isFavorite"
          @toggle-favorite="$emit('toggle-favorite')" @share="$emit('share')" @open-config="$emit('open-config')"
          @export-nota="$emit('export-nota')" />

        <!-- Editor Info Bar -->
        <div class="flex items-center justify-between px-4 py-2 text-sm text-muted-foreground border-t">
          <div class="flex items-center gap-2">
            <Button variant="ghost" size="sm" class="flex items-center gap-2"
              @click="toggleSidebar('references')"
              :class="{ 'bg-muted': sidebars.references.isOpen }" title="References (Ctrl+Shift+Alt+R)">
              <BookIcon class="h-4 w-4" />
            </Button>

            <Button variant="ghost" size="sm" class="flex items-center gap-2"
              @click="toggleSidebar('jupyter')"
              :class="{ 'bg-muted': sidebars.jupyter.isOpen }" title="Jupyter Servers (Ctrl+Shift+Alt+J)">
              <ServerIcon class="h-4 w-4" />
            </Button>

            <Button variant="ghost" size="sm" class="flex items-center gap-2"
              @click="toggleSidebar('ai')"
              :class="{ 'bg-muted': sidebars.ai.isOpen }" title="AI Assistant (Ctrl+Shift+Alt+I)">
              <BrainIcon class="h-4 w-4" />
            </Button>

            <Button variant="ghost" size="sm" class="flex items-center gap-2"
              @click="toggleSidebar('metadata')"
              :class="{ 'bg-muted': sidebars.metadata.isOpen }" title="Metadata (Ctrl+Shift+Alt+L)">
              <Tag class="h-4 w-4" />
            </Button>
            
            <Button variant="ghost" size="sm" class="flex items-center gap-2"
              @click="toggleSidebar('favorites')"
              :class="{ 'bg-muted': sidebars.favorites.isOpen }" title="Favorite Blocks (Ctrl+Shift+Alt+V)">
              <Star class="h-4 w-4" />
            </Button>

            <Button variant="ghost" size="sm" class="flex items-center gap-2"
              @click="toggleSidebar('toc')"
              :class="{ 'bg-muted': sidebars.toc.isOpen }" title="Table of Contents (Ctrl+Shift+Alt+O)">
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <rect x="9" y="3" width="6" height="4" rx="1" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M9 12h6M9 16h6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </Button>

            <!-- Add shared session mode toggle button -->
            <Button
              variant="ghost"
              size="sm"
              class="flex items-center gap-2"
              @click="toggleSharedSessionMode"
              :class="{ 'bg-muted': codeExecutionStore.sharedSessionMode, 'opacity-80': isTogglingSharedMode }"
              :title="codeExecutionStore.sharedSessionMode ? 'Shared kernel session enabled (Click to disable)' : 'Enable shared kernel session for all code blocks'"
            >
              <Link2 
                class="h-4 w-4" 
                :class="{ 'text-primary': codeExecutionStore.sharedSessionMode }"
              />
              <span v-if="isTogglingSharedMode" class="h-3 w-3 animate-spin rounded-full border-2 border-solid border-current border-r-transparent"></span>
            </Button>
          </div>

          <!-- Action Buttons -->
          <div class="flex items-center gap-2">
            <Button variant="ghost" size="icon" title="Save Version" @click="saveVersion" :disabled="isSavingVersion">
              <span v-if="isSavingVersion"
                class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-solid border-current border-r-transparent"></span>
              <Save v-else class="w-4 h-4" />
            </Button>
            <Button variant="ghost" size="icon" title="History" @click="showVersionHistory = true">
              <Clock class="w-4 h-4" />
            </Button>

            <!-- Action Buttons -->
            <Button v-if="canRunAll" variant="ghost" size="icon" title="Run All" :disabled="isExecutingAll"
              @click="$emit('run-all')">
              <Loader2 v-if="isExecutingAll" class="w-4 h-4 animate-spin" />
              <PlayCircle v-else class="w-4 h-4" />
            </Button>
            <Button variant="ghost" size="icon" title="Star" @click="$emit('toggle-favorite')"
              :class="{ 'text-yellow-500': isFavorite }">
              <Star class="w-4 h-4" :fill="isFavorite ? 'currentColor' : 'none'" />
            </Button>
            <Button variant="ghost" size="icon" title="Share" @click="$emit('share')">
              <Share2 class="w-4 h-4" />
            </Button>
            <Button variant="ghost" size="icon" title="Export" @click="$emit('export-nota')">
              <Download class="w-4 h-4" />
            </Button>
            <span>{{ wordCount }} words</span>
          </div>
        </div>
      </div>

      <!-- Editor Content -->
      <div class="flex-1 min-h-0 relative overflow-auto">
        <!-- Editor Content Area -->
        <div class="h-full overflow-hidden px-4 md:px-8 lg:px-12">
          <ScrollArea class="h-full">
            <div class="max-w-4xl mx-auto py-8">
              <!-- The title is now the first block inside the editor -->
              <editor-content :editor="editor" />
              <!-- Tags and Save Status below title -->
              <div class="flex items-center gap-4 mt-2">
                <TagsInput v-if="currentNota" v-model="currentNota.tags" class="w-full border-none" />
                <div class="flex items-center text-xs text-muted-foreground transition-opacity duration-200"
                  :class="{ 'opacity-0': !isSaving && !showSaved }">
                  <span v-if="isSaving" class="flex items-center gap-1">
                    <RotateCw class="w-3 h-3 animate-spin" />
                    Saving
                  </span>
                  <span v-else-if="showSaved" class="flex items-center gap-1">
                    <CheckCircle class="w-3 h-3 text-green-600" />
                    Saved
                  </span>
                </div>
              </div>
            </div>
          </ScrollArea>
        </div>
      </div>
    </div>

    <!-- Right-side Sidebars -->
    <!-- Generate sidebars dynamically for all non-TOC sidebars -->
    <template v-for="(config, id) in sidebars" :key="id">
      <div 
        v-if="id !== 'toc' && config.isOpen"
        class="right-sidebar-container"
      >
        <!-- Sidebar Header -->
        <div class="py-1 px-2 border-b flex items-center justify-between">
          <div class="flex items-center ">
            <component :is="config.icon" v-if="config.icon" class="h-3.5 w-3.5 text-primary" />
            <h3 class="text-sm font-medium">{{ config.title }}</h3>
          </div>
          <Button variant="ghost" size="icon" class="h-5 w-5 -mr-1" @click="toggleSidebar(id)">
            <svg 
              xmlns="http://www.w3.org/2000/svg" 
              width="24" 
              height="24" 
              viewBox="0 0 24 24" 
              fill="none" 
              stroke="currentColor" 
              stroke-width="2" 
              stroke-linecap="round" 
              stroke-linejoin="round" 
              class="w-3 h-3"
            >
              <path d="M18 6 6 18"></path>
              <path d="m6 6 12 12"></path>
            </svg>
          </Button>
        </div>
        
        <!-- Sidebar Content -->
        <div class="flex-1 flex flex-col relative overflow-hidden w-full h-full p-0 m-0">
          <!-- Dynamic sidebar content based on ID -->
          <component 
            :is="{
              'references': ReferencesSidebar,
              'jupyter': JupyterServersSidebar,
              'ai': AIAssistantSidebar,
              'metadata': MetadataSidebar,
              'favorites': FavoriteBlocksSidebar
            }[id]" 
            :editor="editor" 
            :notaId="notaId"
            :hideHeader="id === 'ai'"
            class="h-full w-full flex-1 overflow-hidden"
          />
        </div>
      </div>
    </template>

    <!-- Version History Dialog -->
    <VersionHistoryDialog :nota-id="notaId" v-model:open="showVersionHistory"
      @version-restored="refreshEditorContent" />
  </div>
</template>

<style>
/* Apply the editor-specific class to the editable ProseMirror instance */
:deep(.ProseMirror) {
  min-height: calc(100vh - 10rem);
}

/* Right sidebar container styles */
.right-sidebar-container {
  min-width: 300px;
  /* Default width that can be overridden by resize */
  max-width: 800px;
  position: relative;
}

/* Resize handle styles */
.sidebar-resize-handle {
  position: absolute;
  left: 0;
  top: 0;
  width: 4px;
  height: 100%;
  cursor: ew-resize;
  background-color: transparent;
  transition: background-color 0.2s;
}

.sidebar-resize-handle:hover,
.sidebar-resize-handle.resizing {
  background-color: rgba(0, 0, 0, 0.1);
}

/* When resizing is active, use this class on body */
body.sidebar-resizing {
  cursor: ew-resize !important;
  user-select: none !important;
}
</style>








